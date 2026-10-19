import { connect } from 'node:net'
import type { HelperStatus } from '../shared/tunnelState'

export const PIPE_PATH = process.platform === 'win32' ? '\\\\.\\pipe\\PrivataVPN' : '/run/privata-vpn/helper.sock'
const MAX_RESPONSE = 1024 * 1024

export interface HelperRequest {
  op: 'hello' | 'status' | 'connect' | 'disconnect' | 'recover' | 'logs' | 'shutdown'
  config?: string
  options?: { killSwitch: boolean; allowLan: boolean }
  split?: { mode: string; apps: string[] }
  staleAfterSec?: number
  tail?: number
}

export interface HelperResponse {
  ok: boolean
  error?: { code: string; message: string }
  status?: HelperStatus
  version?: string
  logs?: string[]
}

export class HelperError extends Error {
  constructor(
    public readonly code: 'missing' | 'unsupported' | 'timeout' | 'io' | 'busy-denied',
    message: string
  ) {
    super(message)
  }
}

/** Один запрос — одно соединение с каналом службы. Содержимое запроса (конфигурация) не логируется. */
export function helperRequest(req: HelperRequest, timeoutMs = 8000): Promise<HelperResponse> {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return Promise.reject(new HelperError('unsupported', 'Привилегированная служба доступна только в Windows и Linux.'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let buf = ''
    const sock = connect(PIPE_PATH)
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new HelperError('timeout', 'Служба не отвечает.'))), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_RESPONSE) return done(() => reject(new HelperError('io', 'Слишком большой ответ службы.')))
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        const line = buf.slice(0, nl)
        done(() => {
          try {
            resolve(JSON.parse(line) as HelperResponse)
          } catch {
            reject(new HelperError('io', 'Некорректный ответ службы.'))
          }
        })
      }
    })
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') return done(() => reject(new HelperError('missing', 'Служба AmneziaWG Client не установлена или не запущена.')))
      if (e.code === 'EACCES' || e.code === 'EPERM') return done(() => reject(new HelperError('busy-denied', 'Нет доступа к службе AmneziaWG Client.')))
      done(() => reject(new HelperError('io', `Ошибка связи со службой (${e.code ?? 'unknown'}).`)))
    })
    sock.on('close', () => done(() => reject(new HelperError('io', 'Служба закрыла соединение без ответа.'))))
  })
}
