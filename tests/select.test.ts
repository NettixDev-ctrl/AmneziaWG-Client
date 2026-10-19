import { describe, expect, it } from 'vitest'
import { parseAwgConfig } from '../src/shared/awgConfig'
import { buildLibrary } from '../src/shared/profiles'
import { qualityOf, rankCandidates, type Candidate, type LatencyInfo } from '../src/shared/select'
import { sampleConfig } from './fixtures'

const lib = buildLibrary(
  [['germany', '203.0.113.1'], ['france', '203.0.113.2'], ['spain', '203.0.113.3'], ['italy', '203.0.113.4']].map(([n, ep], i) => ({
    fileName: `${n}.conf`,
    parsed: parseAwgConfig(sampleConfig({ seed: String(i), endpoint: `${ep}:51821` }))
  }))
)
const cands: Candidate[] = lib.countries.flatMap((group) => group.profiles.map((profile) => ({ group, profile })))
const ok = (rtt: number): LatencyInfo => ({ state: 'ok', rttMs: rtt, measuredAt: 1 })
const names = (c: Candidate[]): string[] => c.map((x) => x.group.code!)

describe('выбор профиля по измеренной задержке', () => {
  it('сначала измеренные по возрастанию RTT, затем неизвестные', () => {
    const lat = new Map<string, LatencyInfo>([['203.0.113.1', ok(120)], ['203.0.113.3', ok(30)]])
    expect(names(rankCandidates(cands, lat, { preferred: [] }))).toEqual(['ES', 'DE', 'IT', 'FR'])
  })

  it('без измерений используется предпочтение, затем порядок библиотеки — ничего не выдумывается', () => {
    const noLat = new Map<string, LatencyInfo>()
    const base = names(rankCandidates(cands, noLat, { preferred: [] }))
    expect(base).toEqual(['FR', 'DE', 'IT', 'ES'].sort((a, b) => base.indexOf(a) - base.indexOf(b)))
    const preferred = cands.find((c) => c.group.code === 'IT')!.profile.id
    expect(names(rankCandidates(cands, noLat, { preferred: [preferred] }))[0]).toBe('IT')
  })

  it('разница меньше 8 мс — ничья, побеждает предпочтительный', () => {
    const lat = new Map<string, LatencyInfo>([['203.0.113.1', ok(50)], ['203.0.113.2', ok(46)]])
    const pref = cands.find((c) => c.group.code === 'DE')!.profile.id
    expect(names(rankCandidates(cands, lat, { preferred: [pref] })).slice(0, 2)).toEqual(['DE', 'FR'])
    const lat2 = new Map<string, LatencyInfo>([['203.0.113.1', ok(80)], ['203.0.113.2', ok(46)]])
    expect(names(rankCandidates(cands, lat2, { preferred: [pref] })).slice(0, 2)).toEqual(['FR', 'DE'])
  })

  it('неудачные измерения не считаются числом', () => {
    const lat = new Map<string, LatencyInfo>([['203.0.113.1', { state: 'unreachable', rttMs: null, measuredAt: 1 }], ['203.0.113.2', ok(200)]])
    expect(names(rankCandidates(cands, lat, { preferred: [] }))[0]).toBe('FR')
  })

  it('качество: неизвестное остаётся неизвестным', () => {
    expect(qualityOf(undefined)).toBe('unknown')
    expect(qualityOf({ state: 'unreachable', rttMs: null, measuredAt: 1 })).toBe('unknown')
    expect(qualityOf(ok(20))).toBe('good')
    expect(qualityOf(ok(120))).toBe('fair')
    expect(qualityOf(ok(400))).toBe('poor')
  })
})
