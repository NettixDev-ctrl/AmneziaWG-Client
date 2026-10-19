import { describe, expect, it } from 'vitest'
import { buildTunnelConfig, detectAwgVersion, handshakeStaleAfterSeconds, parseAwgConfig, parseEndpoint, parseUintRange, redactSecrets } from '../src/shared/awgConfig'
import { fakeKey, sampleConfig } from './fixtures'

describe('разбор конфигурации AWG', () => {
  it('принимает конфигурацию AWG 3.x и определяет версию', () => {
    const r = parseAwgConfig(sampleConfig())
    expect(r.ok).toBe(true)
    expect(r.summary?.awgVersion).toBe('3.x')
    expect(r.summary?.endpointHost).toBe('203.0.113.7')
    expect(r.summary?.endpointPort).toBe(51821)
    expect(r.summary?.fullTunnel).toBe(true)
    expect(r.summary?.awgParams).toContain('HeaderProtectionKey')
    expect(r.config?.iface.params.H1).toBe('1263359724-1263359837')
  })

  it('резюме не содержит секретов', () => {
    const r = parseAwgConfig(sampleConfig())
    const dump = JSON.stringify(r.summary) + JSON.stringify(r.issues)
    expect(dump).not.toContain(fakeKey('a:priv'))
    expect(dump).not.toContain(fakeKey('a:psk'))
  })

  it('определяет версии протокола', () => {
    expect(detectAwgVersion({})).toBe('wireguard')
    expect(detectAwgVersion({ Jc: '4', S1: '1', H1: '5' })).toBe('1.0')
    expect(detectAwgVersion({ Jc: '4', I1: '<b 0x00>' })).toBe('1.5')
    expect(detectAwgVersion({ S3: '1' })).toBe('2.0')
    expect(detectAwgVersion({ H1: '5-9' })).toBe('2.0')
    expect(detectAwgVersion({ RekeyTimeout: '5' })).toBe('3.x')
  })

  it('принимает обычный WireGuard', () => {
    const r = parseAwgConfig(sampleConfig({ omit: ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts'] }))
    expect(r.ok).toBe(true)
    expect(r.summary?.awgVersion).toBe('wireguard')
  })

  it('понятно сообщает об ошибках и не раскрывает значения', () => {
    const bad = sampleConfig().replace(/PrivateKey = .*/, 'PrivateKey = not-a-key-SECRETVALUE')
    const r = parseAwgConfig(bad)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.code === 'bad-private-key')).toBe(true)
    expect(JSON.stringify(r.issues)).not.toContain('SECRETVALUE')
  })

  it('находит отсутствующие разделы и параметры', () => {
    expect(parseAwgConfig('').ok).toBe(false)
    expect(parseAwgConfig('[Interface]\nAddress = 10.0.0.2/32\n').issues.map((i) => i.code)).toEqual(expect.arrayContaining(['no-private-key', 'no-peer']))
    expect(parseAwgConfig(sampleConfig({ omit: ['Endpoint'] })).issues.some((i) => i.code === 'no-endpoint')).toBe(true)
  })

  it('проверяет диапазоны и заголовки', () => {
    expect(parseAwgConfig(sampleConfig({ extraInterface: ['H1 = 9-1'] })).ok).toBe(false)
    const overlap = sampleConfig().replace('H2 = 968797362-968797585', 'H2 = 1263359800-1263359900')
    expect(parseAwgConfig(overlap).issues.some((i) => i.code === 'header-overlap')).toBe(true)
    const junk = sampleConfig().replace('Jmin = 10', 'Jmin = 99')
    expect(parseAwgConfig(junk).issues.some((i) => i.code === 'junk-range')).toBe(true)
  })

  it('игнорирует скрипты с предупреждением', () => {
    const r = parseAwgConfig(sampleConfig({ extraInterface: ['PostUp = calc.exe'] }))
    expect(r.ok).toBe(true)
    expect(r.issues.some((i) => i.code === 'scripts-ignored')).toBe(true)
    expect(buildTunnelConfig(r.config!, { routeMode: 'killswitch', ipv6: 'tunnel' })).not.toMatch(/PostUp|calc/i)
  })

  it('отсекает слишком большие и бинарные файлы', () => {
    expect(parseAwgConfig('x'.repeat(70000)).issues[0]?.code).toBe('too-large')
    expect(parseAwgConfig('[Interface]\u0000').issues[0]?.code).toBe('binary')
  })

  it('разбирает endpoint и диапазоны', () => {
    expect(parseEndpoint('1.2.3.4:51820')).toEqual({ host: '1.2.3.4', port: 51820 })
    expect(parseEndpoint('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 })
    expect(parseEndpoint('vpn.example.com:1')).toEqual({ host: 'vpn.example.com', port: 1 })
    expect(parseEndpoint('1.2.3.4:0')).toBeNull()
    expect(parseEndpoint('1.2.3.4')).toBeNull()
    expect(parseUintRange('15-24')).toEqual([15, 24])
    expect(parseUintRange('7')).toEqual([7, 7])
    expect(parseUintRange('9-1')).toBeNull()
  })
})

describe('итоговая конфигурация туннеля', () => {
  const parsed = parseAwgConfig(sampleConfig())

  it('сохраняет AWG-параметры без изменений и маршруты /0 при kill switch', () => {
    const text = buildTunnelConfig(parsed.config!, { routeMode: 'killswitch', ipv6: 'tunnel' })
    expect(text).toContain('H1 = 1263359724-1263359837')
    expect(text).toContain('HeaderProtectionKey =')
    expect(text).toContain('AllowedIPs = 0.0.0.0/0, ::/0')
  })

  it('без kill switch заменяет /0 на /1 + /1', () => {
    const text = buildTunnelConfig(parsed.config!, { routeMode: 'no-killswitch', ipv6: 'tunnel' })
    expect(text).toContain('AllowedIPs = 0.0.0.0/1, 128.0.0.0/1, ::/1, 8000::/1')
  })

  it('применяет свои DNS и MTU, убирает IPv6 по настройке', () => {
    const text = buildTunnelConfig(parsed.config!, { routeMode: 'killswitch', ipv6: 'system', dns: ['9.9.9.9', '2620:fe::fe'], mtu: 1280 })
    expect(text).toContain('DNS = 9.9.9.9')
    expect(text).not.toContain('2620')
    expect(text).toContain('MTU = 1280')
    expect(text).toContain('AllowedIPs = 0.0.0.0/0')
    expect(text).not.toContain('::/0')
  })

  it('повторно разбирается без потерь', () => {
    const text = buildTunnelConfig(parsed.config!, { routeMode: 'killswitch', ipv6: 'tunnel' })
    const again = parseAwgConfig(text)
    expect(again.ok).toBe(true)
    expect(again.fingerprint).toBe(parsed.fingerprint)
  })

  it('порог устаревания рукопожатия учитывает RejectAfterTime', () => {
    expect(handshakeStaleAfterSeconds(parsed.config!)).toBe(195)
  })
})

describe('маскирование секретов в журналах', () => {
  it('скрывает ключи и адреса', () => {
    const out = redactSecrets(`PrivateKey = ${fakeKey('x')}\nconnect to 203.0.113.7 key ${fakeKey('y')}`)
    expect(out).not.toContain(fakeKey('x'))
    expect(out).not.toContain(fakeKey('y'))
    expect(out).not.toContain('203.0.113.7')
  })
})
