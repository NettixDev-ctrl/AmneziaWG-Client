import { isIPAddress } from './net'
import { type SplitMode, type SplitRule, isSplitMode, validateSplitRules } from './split'

export type ConnectionMode = 'auto' | 'fast' | 'adaptive'
export type ThemeSetting = 'dark' | 'light' | 'system'
export type StartBehavior = 'show' | 'minimized'

export interface Settings {
  version: 1
  connectionMode: ConnectionMode
  /** «auto» либо идентификатор страны из библиотеки. */
  selectedCountryId: string
  /** «last» — последняя использованная, «auto» — автоматически, либо идентификатор страны. */
  defaultCountryId: string
  autoConnect: boolean
  reconnectOnLoss: boolean
  startBehavior: StartBehavior
  /** Последнее успешное подключение (для «последней использованной» и тай-брейков в Авто). */
  last: { countryId: string | null; profileId: string | null }
  split: { mode: SplitMode; rules: SplitRule[] }
  network: {
    dnsMode: 'config' | 'custom'
    dnsServers: string[]
    mtuMode: 'config' | 'custom'
    mtu: number
    ipv6: 'tunnel' | 'system'
    localNetwork: boolean
    killSwitch: boolean
    recoverOnStart: boolean
  }
  app: {
    startWithWindows: boolean
    minimizeToTray: boolean
    closeToTray: boolean
    notifications: boolean
    language: 'ru'
    /** Пользовательская папка конфигураций; null — папка «configs» рядом с программой. */
    configDir: string | null
    theme: ThemeSetting
    watchConfigDir: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  connectionMode: 'fast',
  selectedCountryId: 'auto',
  defaultCountryId: 'last',
  autoConnect: false,
  reconnectOnLoss: true,
  startBehavior: 'show',
  last: { countryId: null, profileId: null },
  split: { mode: 'all', rules: [] },
  network: {
    dnsMode: 'config',
    dnsServers: [],
    mtuMode: 'config',
    mtu: 1360,
    ipv6: 'tunnel',
    localNetwork: false,
    killSwitch: true,
    recoverOnStart: true
  },
  app: {
    startWithWindows: false,
    minimizeToTray: true,
    closeToTray: true,
    notifications: true,
    language: 'ru',
    configDir: null,
    theme: 'dark',
    watchConfigDir: true
  }
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}
function idString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f]/.test(v) ? v : fallback
}

/** Приводит произвольные данные (файл настроек, patch из UI) к корректному объекту Settings. */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const n = (typeof r.network === 'object' && r.network !== null ? r.network : {}) as Record<string, unknown>
  const a = (typeof r.app === 'object' && r.app !== null ? r.app : {}) as Record<string, unknown>
  const s = (typeof r.split === 'object' && r.split !== null ? r.split : {}) as Record<string, unknown>
  const l = (typeof r.last === 'object' && r.last !== null ? r.last : {}) as Record<string, unknown>

  const dns = Array.isArray(n.dnsServers)
    ? n.dnsServers.filter((x): x is string => typeof x === 'string' && isIPAddress(x.trim())).map((x) => x.trim()).slice(0, 4)
    : base.network.dnsServers
  const mtuRaw = typeof n.mtu === 'number' && Number.isInteger(n.mtu) && n.mtu >= 576 && n.mtu <= 1500 ? n.mtu : base.network.mtu
  const configDir =
    a.configDir === null
      ? null
      : typeof a.configDir === 'string' && a.configDir.length > 0 && a.configDir.length <= 1024 && !a.configDir.includes('\u0000')
        ? a.configDir
        : base.app.configDir

  return {
    version: 1,
    connectionMode: oneOf(r.connectionMode, ['auto', 'fast', 'adaptive'] as const, base.connectionMode),
    selectedCountryId: idString(r.selectedCountryId, base.selectedCountryId),
    defaultCountryId: idString(r.defaultCountryId, base.defaultCountryId),
    autoConnect: bool(r.autoConnect, base.autoConnect),
    reconnectOnLoss: bool(r.reconnectOnLoss, base.reconnectOnLoss),
    startBehavior: oneOf(r.startBehavior, ['show', 'minimized'] as const, base.startBehavior),
    last: {
      countryId: l.countryId === null ? null : idString(l.countryId, base.last.countryId ?? '') || null,
      profileId: l.profileId === null ? null : idString(l.profileId, base.last.profileId ?? '') || null
    },
    split: {
      mode: isSplitMode(s.mode) ? s.mode : base.split.mode,
      rules: s.rules === undefined ? base.split.rules : validateSplitRules(s.rules).valid
    },
    network: {
      dnsMode: oneOf(n.dnsMode, ['config', 'custom'] as const, base.network.dnsMode),
      dnsServers: dns,
      mtuMode: oneOf(n.mtuMode, ['config', 'custom'] as const, base.network.mtuMode),
      mtu: mtuRaw,
      ipv6: oneOf(n.ipv6, ['tunnel', 'system'] as const, base.network.ipv6),
      localNetwork: bool(n.localNetwork, base.network.localNetwork),
      killSwitch: bool(n.killSwitch, base.network.killSwitch),
      recoverOnStart: bool(n.recoverOnStart, base.network.recoverOnStart)
    },
    app: {
      startWithWindows: bool(a.startWithWindows, base.app.startWithWindows),
      minimizeToTray: bool(a.minimizeToTray, base.app.minimizeToTray),
      closeToTray: bool(a.closeToTray, base.app.closeToTray),
      notifications: bool(a.notifications, base.app.notifications),
      language: 'ru',
      configDir,
      theme: oneOf(a.theme, ['dark', 'light', 'system'] as const, base.app.theme),
      watchConfigDir: bool(a.watchConfigDir, base.app.watchConfigDir)
    }
  }
}

/** Накладывает частичное изменение на текущие настройки (с проверкой каждого поля). */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) return current
  const p = patch as Record<string, unknown>
  const merged: Record<string, unknown> = { ...current }
  for (const key of Object.keys(current) as Array<keyof Settings>) {
    if (!(key in p)) continue
    const cur = current[key]
    const val = p[key]
    if (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && typeof val === 'object' && val !== null) {
      merged[key] = { ...cur, ...(val as object) }
    } else {
      merged[key] = val
    }
  }
  return sanitizeSettings(merged, current)
}

/** Фактический режим маршрутов: kill switch блокирует и локальную сеть, поэтому они несовместимы. */
export function effectiveKillSwitch(s: Settings): boolean {
  return s.network.killSwitch && !s.network.localNetwork
}

/** Правила раздельного туннелирования действуют только в режиме «Адаптивный». */
export function effectiveSplitMode(s: Settings): SplitMode {
  return s.connectionMode === 'adaptive' ? s.split.mode : 'all'
}
