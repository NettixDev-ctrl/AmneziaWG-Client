import { createHash } from 'node:crypto'

/** Детерминированный фиктивный ключ (32 байта в base64) — НЕ настоящий секрет. */
export function fakeKey(seed: string): string {
  return createHash('sha256').update('test-key:' + seed).digest().toString('base64')
}

export interface SampleOptions {
  seed?: string
  endpoint?: string
  extraInterface?: string[]
  extraPeer?: string[]
  allowedIps?: string
  omit?: string[]
}

/** Конфигурация в стиле AWG 3.x (значения вымышленные). */
export function sampleConfig(o: SampleOptions = {}): string {
  const seed = o.seed ?? 'a'
  const iface = [
    'Address = 10.61.0.6/32',
    'DNS = 1.1.1.1',
    `PrivateKey = ${fakeKey(seed + ':priv')}`,
    'MTU = 1360',
    'Jc = 4',
    'Jmin = 10',
    'Jmax = 50',
    'S1 = 73',
    'S2 = 55',
    'S3 = 81',
    'S4 = 21',
    'H1 = 1263359724-1263359837',
    'H2 = 968797362-968797585',
    'H3 = 540538806-540538923',
    'H4 = 631494200-631494423',
    `HeaderProtectionKey = ${fakeKey(seed + ':hpk')}`,
    'ContentPaddingAddition = 15-24',
    'RekeyAfterTime = 139',
    'RekeyTimeout = 5-6',
    'RejectAfterTime = 163-175',
    'KeepaliveTimeout = 14',
    'MaxHandshakeAttempts = 19-20',
    ...(o.extraInterface ?? [])
  ].filter((l) => !(o.omit ?? []).some((k) => l.toLowerCase().startsWith(k.toLowerCase() + ' ')))
  const peer = [
    `PublicKey = ${fakeKey(seed + ':pub')}`,
    `PresharedKey = ${fakeKey(seed + ':psk')}`,
    `AllowedIPs = ${o.allowedIps ?? '0.0.0.0/0, ::/0'}`,
    `Endpoint = ${o.endpoint ?? '203.0.113.7:51821'}`,
    'PersistentKeepalive = 23-28',
    ...(o.extraPeer ?? [])
  ].filter((l) => !(o.omit ?? []).some((k) => l.toLowerCase().startsWith(k.toLowerCase() + ' ')))
  return ['[Interface]', ...iface, '', '[Peer]', ...peer, ''].join('\n')
}
