/**
 * ТОЛЬКО ДЛЯ РАЗРАБОТКИ: макет API для просмотра интерфейса в обычном браузере (npm run ui:preview).
 * В production-сборку не попадает (подключается через import.meta.env.DEV). Значения задержек и
 * состояния здесь — иллюстрации для вёрстки, а не измерения; реальное приложение их не использует.
 */
import type { AppSnapshot, CountryView, PrivataApi } from '../../shared/ipc'
import { DEFAULT_SETTINGS, applySettingsPatch } from '../../shared/settings'
import { INITIAL_TUNNEL_STATE, type TunnelState } from '../../shared/tunnelState'

const SAMPLE: Array<[string, string, string | null, number | null]> = [
  ['AT', 'Австрия', null, 140], ['DE', 'Германия', null, 38], ['FR', 'Франция', null, 52], ['GB', 'Великобритания', null, 24],
  ['NL', 'Нидерланды', null, 31], ['US', 'США', null, 128], ['JP', 'Япония', null, 210], ['BR', 'Бразилия', null, null],
  ['HK', 'Гонконг', null, 190], ['IT', 'Италия', null, 61]
]

function country([code, nameRu, , rtt]: [string, string, string | null, number | null]): CountryView {
  const quality = rtt === null ? 'unknown' : rtt < 80 ? 'good' : rtt < 180 ? 'fair' : 'poor'
  return {
    id: code, code, nameRu, custom: false, bestRttMs: rtt, quality,
    profiles: [{ id: `p-${code}`, fileName: `${nameRu}.conf`, title: nameRu, label: '', awgVersion: '3.x', quality, latency: { state: rtt === null ? 'unreachable' : 'ok', rttMs: rtt, measuredAt: 1 }, warnings: [] }]
  }
}

export function createMockApi(): PrivataApi {
  const params = new URLSearchParams(location.search)
  const scenario = params.get('state') ?? 'connected'
  const empty = scenario === 'empty'
  let settings = applySettingsPatch(DEFAULT_SETTINGS, { selectedCountryId: 'GB', connectionMode: 'fast', split: { mode: 'bypass', rules: [{ id: 'a1', exePath: '/usr/bin/telegram-desktop', name: 'Telegram', enabled: true }] } })
  const tunnel: TunnelState = {
    ...INITIAL_TUNNEL_STATE,
    phase: scenario === 'connected' ? 'connected' : scenario === 'handshaking' ? 'handshaking' : scenario === 'failed' ? 'failed' : scenario === 'degraded' ? 'degraded' : 'idle',
    profileId: 'p-GB', handshakeAgeSec: scenario === 'connected' ? 12 : null, rxBytes: 48_123_456, txBytes: 6_300_000,
    errorCode: scenario === 'failed' ? 'handshake-timeout' : null, error: scenario === 'failed' ? 'Сервер не ответил: рукопожатие не выполнено.' : null
  }
  const listeners = new Set<(s: AppSnapshot) => void>()
  const snap = (): AppSnapshot => ({
    platform: 'linux', appVersion: '0.1.0', tunnel,
    active: tunnel.phase === 'idle' ? { countryId: null, countryName: null, countryCode: null, profileTitle: null } : { countryId: 'GB', countryName: 'Великобритания', countryCode: 'GB', profileTitle: 'Великобритания' },
    connectedSince: tunnel.phase === 'connected' ? Date.now() - 600_000 : null,
    library: {
      configDir: '/home/user/.awg/configs', exists: !empty, dirError: null, countries: empty ? [] : SAMPLE.map(country),
      invalid: scenario === 'issues' ? [{ fileName: 'spain.conf', issues: [{ severity: 'error', code: 'x', message: 'PrivateKey имеет неверный формат.' }] }] : [], duplicateFiles: [], totalFiles: empty ? 0 : SAMPLE.length, scannedAt: 1
    },
    settings, helper: scenario === 'nohelper' ? { state: 'missing', message: 'Служба не установлена' } : { state: 'ok', version: '0.1.0' },
    split: { state: scenario === 'connected' ? 'running' : 'off', error: null, activeFlows: 14 }, reconnect: null, measuring: false
  })
  const emit = (): void => listeners.forEach((l) => l(snap()))
  const ok = async (): Promise<{ ok: true }> => ({ ok: true })
  return {
    getSnapshot: async () => snap(),
    onSnapshot: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    connect: ok, disconnect: ok, toggle: ok, refreshConfigs: ok, measureLatency: ok, openConfigFolder: ok, chooseConfigFolder: ok,
    selectCountry: async (id) => { settings = { ...settings, selectedCountryId: id }; emit(); return { ok: true } },
    setSettings: async (p) => { settings = applySettingsPatch(settings, p); emit(); return { ok: true } },
    pickExecutable: async () => ({ ok: true, value: null }),
    listApps: async () => ({ ok: true, value: [
      { exePath: '/opt/google/chrome/chrome', name: 'Google Chrome', source: 'running', processes: 14 },
      { exePath: '/usr/bin/telegram-desktop', name: 'Telegram', source: 'running', processes: 1 },
      { exePath: '/usr/bin/steam', name: 'Steam', source: 'installed' }
    ] }),
    getIcon: async () => null, installHelper: ok, recoverNetwork: ok,
    getDiagnostics: async () => ({ ok: true, value: { appVersion: '0.1.0', helperVersion: '0.1.0', tunnel, split: snap().split, logs: ['2026-10-18T20:00:01Z [info] Состояние туннеля: idle → starting', '2026-10-18T20:00:03Z [info] Состояние туннеля: handshaking → connected'], libraryFiles: SAMPLE.length } }),
    exportDiagnostics: async () => ({ ok: true, value: null }), openExternal: ok, setTitleBarTheme: async () => undefined
  }
}
