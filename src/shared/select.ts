/**
 * Выбор профиля для подключения по РЕАЛЬНО измеренным задержкам.
 * Неизвестная задержка никогда не подменяется выдуманным числом.
 */
import type { CountryGroup, Profile } from './profiles'

export type LatencyState = 'unknown' | 'measuring' | 'ok' | 'unreachable'

export interface LatencyInfo {
  state: LatencyState
  /** Медиана RTT в мс; null, если не измерено. */
  rttMs: number | null
  measuredAt: number | null
}

export type Quality = 'good' | 'fair' | 'poor' | 'unknown'

export function qualityOf(l: LatencyInfo | undefined): Quality {
  if (!l || l.state !== 'ok' || l.rttMs === null) return 'unknown'
  if (l.rttMs < 80) return 'good'
  if (l.rttMs < 180) return 'fair'
  return 'poor'
}

export interface Candidate {
  group: CountryGroup
  profile: Profile
}

export interface RankOptions {
  /** Предпочитаемые идентификаторы профилей при равенстве/неизвестности (последний успешный и т.п.). */
  preferred: string[]
  /** Явный приоритет страны (код/идентификатор группы) при отсутствии измерений. */
  preferredGroupId?: string | null
}

/** Ключ endpoint — одинаковые адреса дают одинаковые измерения. */
export function endpointKey(p: Profile): string | null {
  return p.summary?.endpointHost ?? null
}

/**
 * Упорядочивает кандидатов: сначала с измеренной задержкой (по возрастанию), затем без измерений
 * (в порядке предпочтения: последний успешный → страна по умолчанию → порядок библиотеки).
 * Разница меньше 8 мс считается ничьей и решается предпочтением, чтобы не «прыгать» из-за шума.
 */
export function rankCandidates(cands: Candidate[], latency: Map<string, LatencyInfo>, opt: RankOptions): Candidate[] {
  const pref = (c: Candidate): number => {
    const i = opt.preferred.indexOf(c.profile.id)
    if (i >= 0) return i
    if (opt.preferredGroupId && c.group.id === opt.preferredGroupId) return opt.preferred.length
    return opt.preferred.length + 1
  }
  const rtt = (c: Candidate): number | null => {
    const key = endpointKey(c.profile)
    const l = key ? latency.get(key) : undefined
    return l && l.state === 'ok' && l.rttMs !== null ? l.rttMs : null
  }
  const indexed = cands.map((c, i) => ({ c, i, r: rtt(c), p: pref(c) }))
  indexed.sort((a, b) => {
    if (a.r !== null && b.r !== null) {
      if (Math.abs(a.r - b.r) >= 8) return a.r - b.r
      return a.p - b.p || a.r - b.r || a.i - b.i
    }
    if (a.r !== null) return -1
    if (b.r !== null) return 1
    return a.p - b.p || a.i - b.i
  })
  return indexed.map((x) => x.c)
}
