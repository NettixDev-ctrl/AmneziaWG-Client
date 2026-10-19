import { describe, expect, it } from 'vitest'
import { median, parsePingOutput, pingHost } from '../src/main/latency'

describe('измерение задержки', () => {
  it('разбирает вывод ping Windows (английская и русская локали)', () => {
    const en = 'Reply from 1.2.3.4: bytes=32 time=23ms TTL=57\r\nReply from 1.2.3.4: bytes=32 time<1ms TTL=57'
    const ru = 'Ответ от 1.2.3.4: число байт=32 время=41мс TTL=57\r\nОтвет от 1.2.3.4: число байт=32 время=39мс TTL=57'
    expect(parsePingOutput(en)).toEqual([23, 1])
    expect(parsePingOutput(ru)).toEqual([41, 39])
    // кириллица, прочитанная в неверной кодировке, не мешает
    expect(parsePingOutput('Ru Ru: bytes=32 âðåìÿ=12ìñ TTL=60')).toEqual([12])
  })

  it('разбирает вывод Linux и пустой вывод', () => {
    expect(parsePingOutput('64 bytes from x: icmp_seq=1 ttl=55 time=12.3 ms')).toEqual([12.3])
    expect(parsePingOutput('Request timed out.\r\nRequest timed out.')).toEqual([])
  })

  it('медиана и честное «неизвестно»', async () => {
    expect(median([])).toBeNull()
    expect(median([30, 10, 20])).toBe(20)
    expect(median([10, 20])).toBe(15)
    // некорректное имя хоста не передаётся в процесс
    expect((await pingHost('1.2.3.4; rm -rf /')).state).toBe('unknown')
    expect((await pingHost('-n')).state).toBe('unknown')
  })
})
