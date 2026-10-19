/**
 * Разбор и проверка конфигураций AmneziaWG (wg-quick-формат с расширениями AWG 1.x–3.x).
 *
 * Модуль не логирует и не возвращает значения ключей: сообщения об ошибках называют только
 * имя параметра. Окончательную проверку при подключении выполняет разбор самой библиотеки
 * amneziawg-windows внутри привилегированной службы.
 */
import { createHash } from 'node:crypto'
import { isCidr, isIPAddress, isIPv4, isIPv6, parseEndpoint } from './net'

export { isCidr, isIPAddress, isIPv4, isIPv6, parseEndpoint }

export type AwgVersion = 'wireguard' | '1.0' | '1.5' | '2.0' | '3.x'

export interface ConfigIssue {
  severity: 'error' | 'warning'
  /** Короткий машинный код (используется в тестах и диагностике). */
  code: string
  /** Дружелюбное сообщение на русском. */
  message: string
}

export interface AwgInterface {
  privateKey?: string
  addresses: string[]
  dns: string[]
  mtu?: number
  listenPort?: number
  /** Параметры AWG в каноничном регистре, значения как в файле. */
  params: Record<string, string>
}

export interface AwgPeer {
  publicKey?: string
  presharedKey?: string
  allowedIps: string[]
  endpoint?: string
  persistentKeepalive?: string
}

export interface AwgConfig {
  iface: AwgInterface
  peers: AwgPeer[]
}

export interface ConfigSummary {
  awgVersion: AwgVersion
  endpointHost: string | null
  endpointPort: number | null
  addresses: string[]
  dns: string[]
  mtu: number | null
  /** AllowedIPs содержит маршрут /0 (весь трафик). */
  fullTunnel: boolean
  /** AllowedIPs содержит IPv6-маршрут по умолчанию. */
  routesIPv6: boolean
  /** Имена AWG-параметров, присутствующих в файле (без значений). */
  awgParams: string[]
}

export interface ParseResult {
  ok: boolean
  config: AwgConfig | null
  summary: ConfigSummary | null
  issues: ConfigIssue[]
  /** Хэш канонического содержимого (для обнаружения дубликатов). */
  fingerprint: string | null
}

/** Параметры, значением которых может быть диапазон «a-b». */
const RANGE_PARAMS = [
  'H1', 'H2', 'H3', 'H4',
  'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts'
] as const
const INT_PARAMS = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4'] as const
const CPS_PARAMS = ['I1', 'I2', 'I3', 'I4', 'I5'] as const
const BOOL_PARAMS = ['RandomTrailers', 'DisableCookies'] as const
const KEY_PARAMS = ['HeaderProtectionKey'] as const

const AWG_PARAM_NAMES: string[] = [
  ...INT_PARAMS, ...RANGE_PARAMS, ...CPS_PARAMS, ...BOOL_PARAMS, ...KEY_PARAMS
]
const CANONICAL: Map<string, string> = new Map(AWG_PARAM_NAMES.map((n) => [n.toLowerCase(), n]))

const V3_ONLY = new Set([
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime',
  'KeepaliveTimeout', 'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies'
])
const SCRIPT_KEYS = new Set(['preup', 'postup', 'predown', 'postdown'])
const IGNORED_KEYS = new Set(['table', 'fwmark', 'saveconfig'])

export const MAX_CONFIG_BYTES = 64 * 1024

function isBase64Key32(v: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v)) return false
  return Buffer.from(v, 'base64').length === 32
}

function parseIntStrict(v: string): number | null {
  return /^\d{1,10}$/.test(v) ? Number(v) : null
}

/** «15», «15-24» → [min, max]. */
export function parseUintRange(v: string): [number, number] | null {
  const m = /^(\d{1,10})(?:\s*-\s*(\d{1,10}))?$/.exec(v.trim())
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] === undefined ? a : Number(m[2])
  if (a > 4294967295 || b > 4294967295 || a > b) return null
  return [a, b]
}

function splitList(values: string[]): string[] {
  return values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)
}

function stripComment(line: string): string {
  const i = line.indexOf('#')
  return (i >= 0 ? line.slice(0, i) : line).trim()
}

interface RawSection {
  name: 'interface' | 'peer'
  entries: Array<[string, string]>
}

function err(code: string, message: string): ConfigIssue {
  return { severity: 'error', code, message }
}
function warn(code: string, message: string): ConfigIssue {
  return { severity: 'warning', code, message }
}

export function parseAwgConfig(text: string): ParseResult {
  const issues: ConfigIssue[] = []
  const fail = (): ParseResult => ({ ok: false, config: null, summary: null, issues, fingerprint: null })

  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    issues.push(err('too-large', 'Файл конфигурации слишком большой (больше 64 КБ).'))
    return fail()
  }
  if (text.includes('\u0000')) {
    issues.push(err('binary', 'Файл не похож на текстовую конфигурацию.'))
    return fail()
  }

  const sections: RawSection[] = []
  let current: RawSection | null = null
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!)
    if (!line) continue
    const sec = /^\[\s*([A-Za-z]+)\s*\]$/.exec(line)
    if (sec) {
      const n = sec[1]!.toLowerCase()
      if (n !== 'interface' && n !== 'peer') {
        issues.push(err('unknown-section', `Строка ${i + 1}: неизвестный раздел [${sec[1]}].`))
        continue
      }
      current = { name: n, entries: [] }
      sections.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 1) {
      issues.push(err('syntax', `Строка ${i + 1}: ожидается формат «параметр = значение».`))
      continue
    }
    if (!current) {
      issues.push(err('no-section', `Строка ${i + 1}: параметр вне раздела [Interface] или [Peer].`))
      continue
    }
    current.entries.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()])
  }

  const ifaceSections = sections.filter((s) => s.name === 'interface')
  const peerSections = sections.filter((s) => s.name === 'peer')
  if (ifaceSections.length !== 1) {
    issues.push(err('interface-count', ifaceSections.length === 0 ? 'В файле нет раздела [Interface].' : 'В файле несколько разделов [Interface] — допускается только один.'))
  }
  if (peerSections.length === 0) issues.push(err('no-peer', 'В файле нет раздела [Peer] (сервера).'))
  if (peerSections.length > 1) issues.push(warn('multi-peer', 'В файле несколько разделов [Peer]; клиент рассчитан на один сервер.'))
  if (ifaceSections.length === 0) return fail()

  // ---- [Interface] ----
  const iface: AwgInterface = { addresses: [], dns: [], params: {} }
  const addressVals: string[] = []
  const dnsVals: string[] = []
  const scripts: string[] = []
  const unknown: string[] = []
  for (const [rawKey, value] of ifaceSections[0]!.entries) {
    const key = rawKey.toLowerCase()
    switch (key) {
      case 'privatekey':
        iface.privateKey = value
        break
      case 'address':
        addressVals.push(value)
        break
      case 'dns':
        dnsVals.push(value)
        break
      case 'mtu': {
        const n = parseIntStrict(value)
        if (n === null || n < 576 || n > 9000) issues.push(err('mtu', 'MTU должен быть числом от 576 до 9000.'))
        else iface.mtu = n
        break
      }
      case 'listenport': {
        const n = parseIntStrict(value)
        if (n === null || n > 65535) issues.push(err('listen-port', 'ListenPort должен быть числом от 0 до 65535.'))
        else iface.listenPort = n
        break
      }
      default: {
        const canon = CANONICAL.get(key)
        if (canon) iface.params[canon] = value
        else if (SCRIPT_KEYS.has(key)) scripts.push(rawKey)
        else if (IGNORED_KEYS.has(key)) unknown.push(rawKey)
        else unknown.push(rawKey)
      }
    }
  }
  iface.addresses = splitList(addressVals)
  iface.dns = splitList(dnsVals)

  if (!iface.privateKey) issues.push(err('no-private-key', 'В [Interface] не указан PrivateKey.'))
  else if (!isBase64Key32(iface.privateKey)) issues.push(err('bad-private-key', 'PrivateKey имеет неверный формат (ожидается 32 байта в base64).'))
  if (iface.addresses.length === 0) issues.push(err('no-address', 'В [Interface] не указан Address.'))
  for (const a of iface.addresses) if (!isCidr(a, false)) issues.push(err('bad-address', `Address «${a}» имеет неверный формат.`))
  for (const d of iface.dns) {
    if (!isIPAddress(d) && !/^[A-Za-z0-9.-]+$/.test(d)) issues.push(err('bad-dns', `DNS «${d}» имеет неверный формат.`))
  }
  if (scripts.length) issues.push(warn('scripts-ignored', `Скрипты (${scripts.join(', ')}) игнорируются из соображений безопасности.`))
  if (unknown.length) issues.push(warn('unknown-keys', `Неизвестные параметры будут пропущены: ${unknown.join(', ')}.`))

  // ---- AWG-параметры ----
  const p = iface.params
  for (const name of INT_PARAMS) {
    const v = p[name]
    if (v === undefined) continue
    const n = parseIntStrict(v)
    if (n === null || n > 65535) issues.push(err('bad-param', `Параметр ${name} должен быть целым числом от 0 до 65535.`))
  }
  for (const name of RANGE_PARAMS) {
    const v = p[name]
    if (v === undefined) continue
    if (!parseUintRange(v)) issues.push(err('bad-param', `Параметр ${name} должен быть числом или диапазоном «мин-макс».`))
  }
  for (const name of BOOL_PARAMS) {
    const v = p[name]
    if (v !== undefined && !/^(true|false|0|1)$/i.test(v)) issues.push(err('bad-param', `Параметр ${name} должен быть true или false.`))
  }
  for (const name of KEY_PARAMS) {
    const v = p[name]
    if (v !== undefined && !isBase64Key32(v)) issues.push(err('bad-param', `Параметр ${name} имеет неверный формат (ожидается 32 байта в base64).`))
  }
  for (const name of CPS_PARAMS) {
    const v = p[name]
    if (v === undefined) continue
    const opens = (v.match(/</g) ?? []).length
    const closes = (v.match(/>/g) ?? []).length
    if (!v.length || opens === 0 || opens !== closes) issues.push(err('bad-param', `Параметр ${name} должен состоять из тегов вида <b 0x…> <r 16>.`))
  }
  const jc = p.Jc !== undefined ? parseIntStrict(p.Jc) : null
  if (jc !== null && jc > 128) issues.push(warn('jc-large', 'Jc больше 128 — такое значение необычно и может замедлить установку соединения.'))
  const jmin = p.Jmin !== undefined ? parseIntStrict(p.Jmin) : null
  const jmax = p.Jmax !== undefined ? parseIntStrict(p.Jmax) : null
  if (jmin !== null && jmax !== null && jmin > jmax) issues.push(err('junk-range', 'Jmin не может быть больше Jmax.'))
  if (jmax !== null && jmax > 1280) issues.push(warn('jmax-large', 'Jmax больше 1280 — пакеты могут не проходить из-за MTU.'))

  const headerRanges: Array<[string, [number, number]]> = []
  for (const name of ['H1', 'H2', 'H3', 'H4'] as const) {
    const v = p[name]
    const r = v !== undefined ? parseUintRange(v) : null
    if (r) headerRanges.push([name, r])
  }
  for (let i = 0; i < headerRanges.length; i++) {
    for (let j = i + 1; j < headerRanges.length; j++) {
      const [na, a] = headerRanges[i]!
      const [nb, b] = headerRanges[j]!
      if (a[0] <= b[1] && b[0] <= a[1]) issues.push(err('header-overlap', `Диапазоны ${na} и ${nb} пересекаются — заголовки должны различаться.`))
    }
  }

  // ---- [Peer] ----
  const peers: AwgPeer[] = []
  for (const sec of peerSections) {
    const peer: AwgPeer = { allowedIps: [] }
    const allowed: string[] = []
    for (const [rawKey, value] of sec.entries) {
      switch (rawKey.toLowerCase()) {
        case 'publickey':
          peer.publicKey = value
          break
        case 'presharedkey':
          peer.presharedKey = value
          break
        case 'allowedips':
          allowed.push(value)
          break
        case 'endpoint':
          peer.endpoint = value
          break
        case 'persistentkeepalive':
          peer.persistentKeepalive = value
          break
        default:
          issues.push(warn('unknown-peer-key', `Неизвестный параметр [Peer] «${rawKey}» будет пропущен.`))
      }
    }
    peer.allowedIps = splitList(allowed)
    if (!peer.publicKey) issues.push(err('no-public-key', 'В [Peer] не указан PublicKey.'))
    else if (!isBase64Key32(peer.publicKey)) issues.push(err('bad-public-key', 'PublicKey имеет неверный формат (ожидается 32 байта в base64).'))
    if (peer.presharedKey !== undefined && !isBase64Key32(peer.presharedKey)) issues.push(err('bad-psk', 'PresharedKey имеет неверный формат (ожидается 32 байта в base64).'))
    if (peer.allowedIps.length === 0) issues.push(err('no-allowed-ips', 'В [Peer] не указан AllowedIPs.'))
    for (const a of peer.allowedIps) if (!isCidr(a, false)) issues.push(err('bad-allowed-ip', `AllowedIPs: «${a}» имеет неверный формат.`))
    if (!peer.endpoint) issues.push(err('no-endpoint', 'В [Peer] не указан Endpoint (адрес сервера).'))
    else if (!parseEndpoint(peer.endpoint)) issues.push(err('bad-endpoint', 'Endpoint должен иметь вид «адрес:порт».'))
    if (peer.persistentKeepalive !== undefined) {
      const r = parseUintRange(peer.persistentKeepalive)
      if (!r || r[1] > 65535) issues.push(err('bad-keepalive', 'PersistentKeepalive должен быть числом (или диапазоном) от 0 до 65535.'))
    }
    peers.push(peer)
  }

  const config: AwgConfig = { iface, peers }
  const ok = !issues.some((i) => i.severity === 'error')
  if (!ok) return { ok: false, config: null, summary: null, issues, fingerprint: null }

  return { ok: true, config, summary: summarize(config), issues, fingerprint: fingerprintOf(config) }
}

export function detectAwgVersion(params: Record<string, string>): AwgVersion {
  const names = Object.keys(params)
  if (names.length === 0) return 'wireguard'
  if (names.some((n) => V3_ONLY.has(n))) return '3.x'
  const hasRangedHeader = ['H1', 'H2', 'H3', 'H4'].some((n) => params[n]?.includes('-'))
  if (params.S3 !== undefined || params.S4 !== undefined || hasRangedHeader) return '2.0'
  if (CPS_PARAMS.some((n) => params[n] !== undefined)) return '1.5'
  return '1.0'
}

function hasDefaultRoute(allowed: string[], family: 4 | 6): boolean {
  return allowed.some((a) => (family === 4 ? a === '0.0.0.0/0' : a === '::/0'))
}

export function summarize(config: AwgConfig): ConfigSummary {
  const peer = config.peers[0]
  const ep = peer?.endpoint ? parseEndpoint(peer.endpoint) : null
  const allowed = config.peers.flatMap((p) => p.allowedIps)
  return {
    awgVersion: detectAwgVersion(config.iface.params),
    endpointHost: ep?.host ?? null,
    endpointPort: ep?.port ?? null,
    addresses: config.iface.addresses,
    dns: config.iface.dns,
    mtu: config.iface.mtu ?? null,
    fullTunnel: hasDefaultRoute(allowed, 4) || hasDefaultRoute(allowed, 6),
    routesIPv6: allowed.some((a) => a.includes(':')),
    awgParams: Object.keys(config.iface.params).sort()
  }
}

/** Отпечаток канонического содержимого: не зависит от порядка строк, регистра ключей и комментариев. */
export function fingerprintOf(config: AwgConfig): string {
  const canon = {
    i: {
      k: config.iface.privateKey,
      a: [...config.iface.addresses].sort(),
      d: [...config.iface.dns].sort(),
      m: config.iface.mtu ?? null,
      p: Object.entries(config.iface.params).sort(([a], [b]) => a.localeCompare(b))
    },
    peers: config.peers.map((p) => ({
      k: p.publicKey, s: p.presharedKey ?? null, a: [...p.allowedIps].sort(), e: p.endpoint ?? null, ka: p.persistentKeepalive ?? null
    }))
  }
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

export type RouteMode = 'killswitch' | 'no-killswitch'

export interface TunnelOptions {
  /** killswitch: оставить маршруты /0 (включает брандмауэр службы); no-killswitch: /1+/1 без правил брандмауэра. */
  routeMode: RouteMode
  /** Свои DNS-серверы (IP). Пустой массив/undefined — взять из конфигурации. */
  dns?: string[]
  mtu?: number
  /** 'tunnel' — оставить ::/0 как в конфигурации; 'system' — не направлять IPv6 в туннель. */
  ipv6: 'tunnel' | 'system'
}

/** Разворачивает «/0» в пару «/1», не активируя kill-switch службы. */
function expandDefaultRoutes(allowed: string[]): string[] {
  const out: string[] = []
  for (const a of allowed) {
    if (a === '0.0.0.0/0') out.push('0.0.0.0/1', '128.0.0.0/1')
    else if (a === '::/0') out.push('::/1', '8000::/1')
    else out.push(a)
  }
  return out
}

/**
 * Формирует итоговый текст конфигурации для привилегированной службы. Скрипты и неизвестные
 * ключи отбрасываются. Результат содержит секреты и не должен попадать в логи или в renderer.
 */
export function buildTunnelConfig(config: AwgConfig, opts: TunnelOptions): string {
  const lines: string[] = ['[Interface]']
  const i = config.iface
  if (i.privateKey) lines.push(`PrivateKey = ${i.privateKey}`)
  const addresses = opts.ipv6 === 'system' ? i.addresses.filter((a) => !a.includes(':')) : i.addresses
  if (addresses.length) lines.push(`Address = ${addresses.join(', ')}`)
  const dns = opts.dns && opts.dns.length > 0 ? opts.dns : i.dns
  const dnsFiltered = opts.ipv6 === 'system' ? dns.filter((d) => !d.includes(':')) : dns
  if (dnsFiltered.length) lines.push(`DNS = ${dnsFiltered.join(', ')}`)
  const mtu = opts.mtu ?? i.mtu
  if (mtu) lines.push(`MTU = ${mtu}`)
  if (i.listenPort !== undefined && i.listenPort > 0) lines.push(`ListenPort = ${i.listenPort}`)
  for (const name of AWG_PARAM_NAMES) {
    const v = i.params[name]
    if (v !== undefined) lines.push(`${name} = ${v}`)
  }
  for (const peer of config.peers) {
    lines.push('', '[Peer]')
    if (peer.publicKey) lines.push(`PublicKey = ${peer.publicKey}`)
    if (peer.presharedKey) lines.push(`PresharedKey = ${peer.presharedKey}`)
    let allowed = peer.allowedIps
    if (opts.ipv6 === 'system') allowed = allowed.filter((a) => !a.includes(':'))
    if (opts.routeMode === 'no-killswitch') allowed = expandDefaultRoutes(allowed)
    lines.push(`AllowedIPs = ${allowed.join(', ')}`)
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`)
    if (peer.persistentKeepalive !== undefined) lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`)
  }
  return lines.join('\n') + '\n'
}

/** Максимум времени, после которого рукопожатие считается устаревшим (с запасом к RejectAfterTime). */
export function handshakeStaleAfterSeconds(config: AwgConfig): number {
  const r = config.iface.params.RejectAfterTime ? parseUintRange(config.iface.params.RejectAfterTime) : null
  const reject = r ? r[1] : 180
  return Math.max(reject, 180) + 15
}

/** Маскирует секреты и адреса в произвольном тексте перед записью в журнал. */
export function redactSecrets(text: string): string {
  return text
    .replace(/((?:private|preshared|public|headerprotection)[_ ]?key\s*[=:]\s*)\S+/gi, '$1<скрыто>')
    .replace(/\b[A-Za-z0-9+/]{43}=/g, '<ключ скрыт>')
    .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, '$1.$2.x.x')
}
