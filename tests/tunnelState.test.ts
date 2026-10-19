import { describe, expect, it } from 'vitest'
import { INITIAL_TUNNEL_STATE, reduceTunnel, type HelperStatus, type TunnelEvent, type TunnelState } from '../src/shared/tunnelState'

const status = (p: Partial<HelperStatus> = {}): HelperStatus => ({
  state: 'running', handshakeAgeSec: null, rxBytes: 0, txBytes: 0, errorCode: null, error: null,
  split: { state: 'off', error: null, activeFlows: 0 }, ...p
})
const ev = (s: HelperStatus, now: number): TunnelEvent => ({ type: 'helper-status', status: s, now, handshakeTimeoutMs: 20_000, staleAfterSec: 195 })
const run = (events: TunnelEvent[], from: TunnelState = INITIAL_TUNNEL_STATE): TunnelState => events.reduce(reduceTunnel, from)
const start = (now = 1000): TunnelEvent => ({ type: 'connect-requested', profileId: 'p1', now })

describe('состояния туннеля', () => {
  it('запуск службы без рукопожатия НЕ означает «подключено»', () => {
    const s = run([start(), ev(status({ state: 'running', handshakeAgeSec: null }), 2000)])
    expect(s.phase).toBe('handshaking')
  })

  it('подключено только после свежего рукопожатия', () => {
    const s = run([start(), ev(status({ state: 'starting' }), 1500), ev(status({ handshakeAgeSec: 1 }), 2500)])
    expect(s.phase).toBe('connected')
    expect(s.profileId).toBe('p1')
  })

  it('устаревшее рукопожатие при старте не считается соединением', () => {
    const s = run([start(), ev(status({ handshakeAgeSec: 9999 }), 2000)])
    expect(s.phase).toBe('handshaking')
  })

  it('таймаут рукопожатия → ошибка', () => {
    const s = run([start(1000), ev(status(), 5000), ev(status(), 22_000)])
    expect(s.phase).toBe('failed')
    expect(s.errorCode).toBe('handshake-timeout')
  })

  it('потеря рукопожатия → degraded, возврат → connected', () => {
    let s = run([start(), ev(status({ handshakeAgeSec: 3 }), 2000)])
    s = reduceTunnel(s, ev(status({ handshakeAgeSec: 300 }), 3000))
    expect(s.phase).toBe('degraded')
    s = reduceTunnel(s, ev(status({ handshakeAgeSec: 2 }), 4000))
    expect(s.phase).toBe('connected')
  })

  it('неожиданное завершение службы → failed', () => {
    let s = run([start(), ev(status({ handshakeAgeSec: 3 }), 2000)])
    s = reduceTunnel(s, ev(status({ state: 'stopped' }), 9000))
    expect(s.phase).toBe('failed')
    expect(s.errorCode).toBe('backend-terminated')
  })

  it('«stopped» сразу после запроса — гонка, а не сбой; позже — сбой', () => {
    let s = run([start(1000), ev(status({ state: 'stopped' }), 1500)])
    expect(s.phase).toBe('starting')
    s = reduceTunnel(s, ev(status({ state: 'stopped' }), 9000))
    expect(s.phase).toBe('failed')
    expect(s.errorCode).toBe('backend-exited')
  })

  it('ошибка службы переносит код и сообщение', () => {
    const s = run([start(), ev(status({ state: 'failed', errorCode: 'create-wintun', error: 'Не удалось создать адаптер' }), 2000)])
    expect(s.phase).toBe('failed')
    expect(s.errorCode).toBe('create-wintun')
    expect(s.error).toBe('Не удалось создать адаптер')
  })

  it('корректное отключение: stopping → idle только после остановки службы', () => {
    let s = run([start(), ev(status({ handshakeAgeSec: 1 }), 2000), { type: 'disconnect-requested', now: 3000 }])
    expect(s.phase).toBe('stopping')
    s = reduceTunnel(s, ev(status({ state: 'running', handshakeAgeSec: 1 }), 3500))
    expect(s.phase).toBe('stopping')
    s = reduceTunnel(s, ev(status({ state: 'stopped' }), 4000))
    expect(s.phase).toBe('idle')
    expect(s.profileId).toBeNull()
  })

  it('недоступная служба при активном туннеле → failed; в покое игнорируется', () => {
    expect(run([{ type: 'helper-unreachable', now: 1, message: 'x' }]).phase).toBe('idle')
    const s = run([start(), { type: 'helper-unreachable', now: 5000, message: 'Служба недоступна' }])
    expect(s.phase).toBe('failed')
    expect(s.errorCode).toBe('helper-unreachable')
  })

  it('новый запрос во время остановки игнорируется, после ошибки — разрешён', () => {
    const stopping = run([start(), { type: 'disconnect-requested', now: 2000 }])
    expect(reduceTunnel(stopping, start(3000)).phase).toBe('stopping')
    const failedState = run([start(), ev(status({ state: 'failed' }), 2000)])
    expect(reduceTunnel(failedState, start(3000)).phase).toBe('starting')
  })

  it('отключение из состояния ошибки сбрасывает его', () => {
    const failedState = run([start(), ev(status({ state: 'failed' }), 2000)])
    expect(reduceTunnel(failedState, { type: 'disconnect-requested', now: 3000 }).phase).toBe('idle')
  })
})
