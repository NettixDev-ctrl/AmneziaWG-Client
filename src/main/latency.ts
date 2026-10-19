import { execFile } from 'node:child_process'
import type { LatencyInfo } from '../shared/select'

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/

/** Разбор вывода ping (Windows любой локали и Linux) → список RTT в мс. */
export function parsePingOutput(out: string): number[] {
  const rtts: number[] = []
  for (const line of out.split(/\r?\n/)) {
    // Windows: «…=23ms TTL=57», «…<1ms TTL=57» (метка «время/time» может быть в другой кодировке)
    let m = /[=<]\s*(\d+)\S*\s+TTL=/.exec(line)
    if (m) {
      rtts.push(Number(m[1]))
      continue
    }
    // Linux/macOS: «time=12.3 ms»
    m = /\btime[=<]\s*([\d.]+)/i.exec(line)
    if (m) rtts.push(Number(m[1]))
  }
  return rtts
}

export function median(v: number[]): number | null {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2)
}

/** Измерение RTT до адреса сервера обычным ICMP-ping (без подключения к VPN). */
export function pingHost(host: string): Promise<LatencyInfo> {
  const now = Date.now()
  if (!HOST_RE.test(host)) return Promise.resolve({ state: 'unknown', rttMs: null, measuredAt: null })
  const args = process.platform === 'win32' ? ['-n', '3', '-w', '1500', host] : ['-c', '3', '-W', '2', host]
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 12_000, encoding: 'latin1', windowsHide: true }, (_err, stdout) => {
      const rtt = median(parsePingOutput(String(stdout ?? '')))
      resolve(rtt === null ? { state: 'unreachable', rttMs: null, measuredAt: now } : { state: 'ok', rttMs: rtt, measuredAt: now })
    })
  })
}

export async function measureHosts(hosts: string[], onResult: (host: string, info: LatencyInfo) => void, concurrency = 4): Promise<void> {
  const queue = [...new Set(hosts)]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) onResult(h, await pingHost(h))
  })
  await Promise.all(workers)
}
