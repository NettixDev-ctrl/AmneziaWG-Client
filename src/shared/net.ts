/** Разбор сетевых адресов без зависимостей от Node — модуль используется и в интерфейсе. */

function ipv4ToNumber(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const parts = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number]
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

export function isIPv4(s: string): boolean {
  return ipv4ToNumber(s) !== null
}

export function isIPv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false
  if ((s.match(/::/g) ?? []).length > 1) return false
  let tail = s
  let extra = 0
  const lastColon = s.lastIndexOf(':')
  const maybeV4 = s.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    if (!isIPv4(maybeV4)) return false
    tail = s.slice(0, lastColon + 1) + '0:0'
    extra = 0
  }
  const groups = tail.split(':')
  const hasDouble = tail.includes('::')
  const nonEmpty = groups.filter((g) => g !== '')
  if (nonEmpty.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false
  const count = nonEmpty.length + extra
  return hasDouble ? count < 8 : count === 8 && groups.length === 8
}

export function isIPAddress(s: string): boolean {
  return isIPv4(s) || isIPv6(s)
}

/** «10.0.0.2/32», «fd00::2/64». Для AllowedIPs допускается и адрес без маски. */
export function isCidr(s: string, requirePrefix = true): boolean {
  const [addr, prefix, ...rest] = s.split('/')
  if (rest.length > 0 || !addr) return false
  if (prefix === undefined) return !requirePrefix && isIPAddress(addr)
  if (!/^\d{1,3}$/.test(prefix)) return false
  const p = Number(prefix)
  if (isIPv4(addr)) return p <= 32
  if (isIPv6(addr)) return p <= 128
  return false
}

export function parseEndpoint(v: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(v.trim())
  if (!m) return null
  const host = (m[1] ?? m[2])!
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  if (m[1] !== undefined && !isIPv6(host)) return null
  if (m[2] !== undefined && !isIPv4(host) && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) return null
  return { host, port }
}

