/**
 * Машина состояний туннеля. Состояние «Подключено» достигается ТОЛЬКО по факту свежего
 * рукопожатия, сообщённого службой, — запуск процесса или службы сам по себе ничего не значит.
 */

export type TunnelPhase = 'idle' | 'starting' | 'handshaking' | 'connected' | 'degraded' | 'stopping' | 'failed'

export type HelperTunnelState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type SplitEngineState = 'off' | 'starting' | 'running' | 'failed'

/** Снимок состояния, который присылает привилегированная служба. */
export interface HelperStatus {
  state: HelperTunnelState
  /** Секунд с последнего рукопожатия; null — рукопожатия ещё не было. */
  handshakeAgeSec: number | null
  rxBytes: number
  txBytes: number
  /** Машиночитаемый код ошибки службы (без секретов). */
  errorCode: string | null
  error: string | null
  split: { state: SplitEngineState; error: string | null; activeFlows: number }
}

export interface TunnelState {
  phase: TunnelPhase
  /** Метка времени (мс) последнего изменения фазы. */
  since: number
  /** Метка времени (мс) запроса подключения — от неё отсчитывается таймаут рукопожатия. */
  requestedAt: number
  profileId: string | null
  errorCode: string | null
  error: string | null
  handshakeAgeSec: number | null
  rxBytes: number
  txBytes: number
}

export type TunnelEvent =
  | { type: 'connect-requested'; profileId: string; now: number }
  | { type: 'disconnect-requested'; now: number }
  | { type: 'helper-status'; status: HelperStatus; now: number; handshakeTimeoutMs: number; staleAfterSec: number }
  | { type: 'helper-unreachable'; now: number; message: string }
  | { type: 'reset'; now: number }

export const INITIAL_TUNNEL_STATE: TunnelState = {
  phase: 'idle',
  since: 0,
  requestedAt: 0,
  profileId: null,
  errorCode: null,
  error: null,
  handshakeAgeSec: null,
  rxBytes: 0,
  txBytes: 0
}

/** Время, в течение которого «stopped» сразу после запроса подключения считается гонкой, а не сбоем. */
const START_GRACE_MS = 4000

function to(state: TunnelState, phase: TunnelPhase, now: number, patch: Partial<TunnelState> = {}): TunnelState {
  return { ...state, ...patch, phase, since: state.phase === phase ? state.since : now }
}

export function reduceTunnel(state: TunnelState, event: TunnelEvent): TunnelState {
  switch (event.type) {
    case 'reset':
      return { ...INITIAL_TUNNEL_STATE, since: event.now }

    case 'connect-requested':
      if (state.phase === 'stopping') return state
      return {
        ...INITIAL_TUNNEL_STATE,
        phase: 'starting',
        since: event.now,
        requestedAt: event.now,
        profileId: event.profileId
      }

    case 'disconnect-requested':
      if (state.phase === 'idle') return state
      if (state.phase === 'failed') return { ...INITIAL_TUNNEL_STATE, since: event.now }
      return to(state, 'stopping', event.now)

    case 'helper-unreachable':
      if (state.phase === 'idle' || state.phase === 'failed') return state
      return to(state, 'failed', event.now, {
        errorCode: 'helper-unreachable',
        error: event.message,
        handshakeAgeSec: null
      })

    case 'helper-status': {
      const { status, now } = event
      const counters = { rxBytes: status.rxBytes, txBytes: status.txBytes, handshakeAgeSec: status.handshakeAgeSec }

      if (status.state === 'failed') {
        if (state.phase === 'idle') return state
        return to(state, 'failed', now, { ...counters, errorCode: status.errorCode ?? 'backend-failed', error: status.error ?? 'Сбой сетевой службы.' })
      }

      switch (state.phase) {
        case 'idle':
        case 'failed':
          return state

        case 'stopping':
          return status.state === 'stopped' ? { ...INITIAL_TUNNEL_STATE, since: now } : state

        case 'starting':
        case 'handshaking': {
          if (status.state === 'stopped') {
            if (now - state.requestedAt < START_GRACE_MS) return state
            return to(state, 'failed', now, { ...counters, errorCode: 'backend-exited', error: 'Сетевая служба остановилась до установки соединения.' })
          }
          if (status.state === 'stopping') return state
          const fresh = status.handshakeAgeSec !== null && status.handshakeAgeSec <= event.staleAfterSec
          if (status.state === 'running' && fresh) {
            return to(state, 'connected', now, { ...counters, errorCode: null, error: null })
          }
          if (now - state.requestedAt > event.handshakeTimeoutMs) {
            return to(state, 'failed', now, { ...counters, errorCode: 'handshake-timeout', error: 'Сервер не ответил: рукопожатие не выполнено.' })
          }
          return to(state, status.state === 'running' ? 'handshaking' : 'starting', now, counters)
        }

        case 'connected':
        case 'degraded': {
          if (status.state === 'stopped' || status.state === 'stopping') {
            return to(state, 'failed', now, { ...counters, errorCode: 'backend-terminated', error: 'Сетевая служба неожиданно завершила работу.' })
          }
          const fresh = status.handshakeAgeSec !== null && status.handshakeAgeSec <= event.staleAfterSec
          return to(state, fresh ? 'connected' : 'degraded', now, { ...counters, errorCode: null, error: null })
        }
      }
    }
  }
}

export function isActivePhase(phase: TunnelPhase): boolean {
  return phase === 'starting' || phase === 'handshaking' || phase === 'connected' || phase === 'degraded'
}
