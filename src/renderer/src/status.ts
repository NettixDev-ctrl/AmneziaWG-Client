import type { AppSnapshot } from '../../shared/ipc'
import type { GlobeTone } from './Globe'

export interface StageStatus {
  tone: GlobeTone
  /** Основной текст рядом с индикатором. */
  label: string
  /** Подсказка под шаром. */
  hint: string
  detail?: string
  kind: 'idle' | 'busy' | 'on' | 'warn' | 'error'
  /** Клик по шару подключает (true) или отключает/отменяет (false). */
  clickConnects: boolean
}

const ERROR_TEXT: Record<string, string> = {
  'helper-missing': 'Служба AmneziaWG Client не установлена.',
  'helper-unsupported': 'Подключение работает только в Windows.',
  'helper-unreachable': 'Служба AmneziaWG Client не отвечает.',
  'handshake-timeout': 'Сервер не ответил на запрос подключения.',
  'backend-terminated': 'Сетевая служба неожиданно завершила работу.',
  'backend-exited': 'Сетевая служба остановилась до установки соединения.'
}

export function describeStage(s: AppSnapshot): StageStatus {
  const t = s.tunnel
  switch (t.phase) {
    case 'connected':
      return { tone: 'on', kind: 'on', label: 'Подключено', hint: 'Нажмите для отключения', clickConnects: false }
    case 'degraded':
      return { tone: 'warn', kind: 'warn', label: 'Нет ответа от сервера', hint: 'Нажмите для отключения', detail: s.reconnect ? 'Идёт переподключение…' : 'Ожидаем рукопожатие…', clickConnects: false }
    case 'starting':
      return { tone: 'busy', kind: 'busy', label: 'Подключение…', hint: 'Нажмите для отмены', clickConnects: false }
    case 'handshaking':
      return { tone: 'busy', kind: 'busy', label: 'Ожидание ответа сервера…', hint: 'Нажмите для отмены', clickConnects: false }
    case 'stopping':
      return { tone: 'busy', kind: 'busy', label: 'Отключение…', hint: 'Подождите', clickConnects: false }
    case 'failed': {
      const msg = (t.errorCode && ERROR_TEXT[t.errorCode]) || t.error || 'Не удалось подключиться.'
      const wait = s.reconnect?.nextInMs != null ? ` Повтор через ${Math.ceil(s.reconnect.nextInMs / 1000)} с.` : ''
      return { tone: 'error', kind: 'error', label: 'Ошибка подключения', hint: 'Нажмите, чтобы повторить', detail: msg + wait, clickConnects: true }
    }
    default:
      return { tone: 'idle', kind: 'idle', label: 'Отключено', hint: 'Нажмите для подключения', clickConnects: true }
  }
}
