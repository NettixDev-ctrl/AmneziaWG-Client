/** Типы обмена между main и renderer. Секретов (ключей, содержимого конфигураций) здесь нет. */
import type { ConfigIssue } from './awgConfig'
import type { LatencyInfo, Quality } from './select'
import type { Settings, SettingsPatch } from './settings'
import type { TunnelState } from './tunnelState'

export interface ProfileView {
  id: string
  fileName: string
  title: string
  label: string
  awgVersion: string
  latency: LatencyInfo
  quality: Quality
  warnings: string[]
}

export interface CountryView {
  id: string
  code: string | null
  nameRu: string
  custom: boolean
  profiles: ProfileView[]
  /** Лучшая (минимальная) измеренная задержка среди профилей; null — не измерено. */
  bestRttMs: number | null
  quality: Quality
}

export interface InvalidFileView {
  fileName: string
  issues: ConfigIssue[]
}

export interface LibraryView {
  configDir: string
  exists: boolean
  dirError: string | null
  countries: CountryView[]
  invalid: InvalidFileView[]
  duplicateFiles: string[]
  totalFiles: number
  scannedAt: number
}

export type HelperAvailability =
  | { state: 'ok'; version: string }
  | { state: 'missing'; message: string }
  | { state: 'unsupported'; message: string }
  | { state: 'error'; message: string }
  | { state: 'unknown' }

export interface ActiveInfo {
  countryId: string | null
  countryName: string | null
  countryCode: string | null
  profileTitle: string | null
}

export interface SplitView {
  state: 'off' | 'starting' | 'running' | 'failed'
  error: string | null
  activeFlows: number
}

export interface AppSnapshot {
  platform: string
  appVersion: string
  tunnel: TunnelState
  active: ActiveInfo
  /** Время (мс), с которого туннель находится в состоянии «подключено». */
  connectedSince: number | null
  library: LibraryView
  settings: Settings
  helper: HelperAvailability
  split: SplitView
  reconnect: { attempt: number; nextInMs: number | null } | null
  measuring: boolean
}

export interface AppEntry {
  /** Полный путь к .exe */
  exePath: string
  name: string
  source: 'installed' | 'running'
  /** Количество запущенных процессов с этим образом (для running). */
  processes?: number
}

export interface DiagnosticsInfo {
  appVersion: string
  helperVersion: string | null
  tunnel: TunnelState
  split: SplitView
  logs: string[]
  libraryFiles: number
}

export type Result<T = void> = ({ ok: true } & (T extends void ? object : { value: T })) | { ok: false; error: string }

export interface PrivataApi {
  getSnapshot(): Promise<AppSnapshot>
  onSnapshot(cb: (s: AppSnapshot) => void): () => void
  connect(countryId: string): Promise<Result>
  disconnect(): Promise<Result>
  toggle(): Promise<Result>
  selectCountry(countryId: string): Promise<Result>
  refreshConfigs(): Promise<Result>
  measureLatency(): Promise<Result>
  setSettings(patch: SettingsPatch): Promise<Result>
  openConfigFolder(): Promise<Result>
  chooseConfigFolder(): Promise<Result>
  pickExecutable(): Promise<Result<AppEntry | null>>
  listApps(): Promise<Result<AppEntry[]>>
  getIcon(exePath: string): Promise<string | null>
  installHelper(): Promise<Result>
  recoverNetwork(): Promise<Result>
  getDiagnostics(): Promise<Result<DiagnosticsInfo>>
  exportDiagnostics(): Promise<Result<string | null>>
  openExternal(target: 'help'): Promise<Result>
  setTitleBarTheme(theme: 'dark' | 'light'): Promise<void>
}

export const IPC = {
  snapshot: 'app:snapshot',
  snapshotEvent: 'app:snapshot-event',
  connect: 'tunnel:connect',
  disconnect: 'tunnel:disconnect',
  toggle: 'tunnel:toggle',
  selectCountry: 'country:select',
  refreshConfigs: 'configs:refresh',
  measureLatency: 'latency:measure',
  setSettings: 'settings:set',
  openConfigFolder: 'configs:open-folder',
  chooseConfigFolder: 'configs:choose-folder',
  pickExecutable: 'apps:pick',
  listApps: 'apps:list',
  getIcon: 'apps:icon',
  installHelper: 'helper:install',
  recoverNetwork: 'helper:recover',
  getDiagnostics: 'diag:get',
  exportDiagnostics: 'diag:export',
  openExternal: 'app:open-external',
  setTitleBarTheme: 'window:titlebar-theme'
} as const
