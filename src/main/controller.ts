import { EventEmitter } from 'node:events'
import { buildTunnelConfig, handshakeStaleAfterSeconds } from '../shared/awgConfig'
import type { ActiveInfo, AppSnapshot, CountryView, HelperAvailability, LibraryView, ProfileView, Result, SplitView } from '../shared/ipc'
import { profileTitle, type CountryGroup, type Profile } from '../shared/profiles'
import {
  endpointKey, qualityOf, rankCandidates, type Candidate, type LatencyInfo
} from '../shared/select'
import {
  applySettingsPatch, effectiveKillSwitch, effectiveSplitMode, type Settings, type SettingsPatch
} from '../shared/settings'
import { splitPayload } from '../shared/split'
import {
  INITIAL_TUNNEL_STATE, isActivePhase, reduceTunnel, type HelperStatus, type TunnelEvent, type TunnelState
} from '../shared/tunnelState'
import { HelperError, helperRequest, type HelperResponse } from './helperClient'
import { measureHosts } from './latency'
import type { Logger } from './logger'
import { readConfigFile, scanConfigDir, type ScanResult } from './scanner'

export interface ControllerDeps {
  log: Logger
  getSettings: () => Settings
  saveSettings: (s: Settings) => Promise<void>
  getConfigDir: () => string
  notify: (title: string, body: string) => void
  appVersion: string
}

const POLL_MS = 1000
const HANDSHAKE_TIMEOUT_MS = 30_000
const DEGRADED_RECONNECT_MS = 60_000
const RECONNECT_DELAYS_S = [2, 5, 10, 20, 30]
const MAX_FAILOVER_ATTEMPTS = 3
const NETWORK_KEYS = ['dnsMode', 'dnsServers', 'mtuMode', 'mtu', 'ipv6', 'killSwitch', 'localNetwork'] as const

/**
 * Центральный объект приложения: библиотека конфигураций, измерения, состояние туннеля.
 * Состояние «подключено» определяется только машиной состояний по ответам службы.
 */
export class Controller extends EventEmitter {
  private scan: ScanResult | null = null
  private latency = new Map<string, LatencyInfo>()
  private tunnel: TunnelState = INITIAL_TUNNEL_STATE
  private helper: HelperAvailability = { state: 'unknown' }
  private split: SplitView = { state: 'off', error: null, activeFlows: 0 }
  private connectedSince: number | null = null
  private measuring = false

  private activeProfileId: string | null = null
  private activeCountryId: string | null = null
  private userWantsConnected = false
  private staleAfterSec = 195
  private queue: Candidate[] = []
  private failoverAttempts = 0
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAt: number | null = null
  private degradedSince: number | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private polling = false
  private applyTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private opChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: ControllerDeps) {
    super()
  }

  // ---------- запуск ----------

  async init(): Promise<void> {
    await this.rescan()
    await this.probeHelper()
    const settings = this.d.getSettings()
    if (this.helper.state === 'ok' && settings.network.recoverOnStart) {
      // Туннель, оставшийся от прошлого запуска (например, после сбоя приложения), сворачивается.
      const st = await this.safeStatus()
      if (st && st.state !== 'stopped') {
        this.d.log.warn('Найден туннель от предыдущего запуска — отключаем.')
        await this.requestHelper({ op: 'disconnect' }).catch(() => undefined)
      }
    }
    void this.measureLatency()
    this.schedulePeriodicMeasure()
  }

  private periodic: NodeJS.Timeout | null = null
  private schedulePeriodicMeasure(): void {
    this.periodic = setInterval(() => {
      if (this.tunnel.phase === 'idle') void this.measureLatency()
    }, 10 * 60_000)
    this.periodic.unref()
  }

  // ---------- библиотека ----------

  async rescan(): Promise<void> {
    const dir = this.d.getConfigDir()
    this.scan = await scanConfigDir(dir)
    const lib = this.scan.library
    this.d.log.info(`Папка конфигураций: найдено файлов ${lib.totalFiles}, стран ${lib.countries.length}, ошибочных ${lib.invalid.length}, дубликатов ${lib.duplicates.length}`)
    const s = this.d.getSettings()
    if (s.selectedCountryId !== 'auto' && !lib.countries.some((c) => c.id === s.selectedCountryId)) {
      await this.d.saveSettings({ ...s, selectedCountryId: 'auto' })
    }
    this.queueEmit()
    if (this.tunnel.phase === 'idle') void this.measureLatency()
  }

  private groups(): CountryGroup[] {
    return this.scan?.library.countries ?? []
  }

  private findProfile(id: string | null): Candidate | null {
    if (!id) return null
    for (const group of this.groups()) {
      const profile = group.profiles.find((p) => p.id === id)
      if (profile) return { group, profile }
    }
    return null
  }

  async measureLatency(): Promise<void> {
    if (this.measuring || this.tunnel.phase !== 'idle') return
    const hosts = [...new Set(this.groups().flatMap((g) => g.profiles.map((p) => endpointKey(p))).filter((h): h is string => !!h))]
    if (hosts.length === 0) return
    this.measuring = true
    for (const h of hosts) this.latency.set(h, { state: 'measuring', rttMs: null, measuredAt: this.latency.get(h)?.measuredAt ?? null })
    this.queueEmit()
    try {
      await measureHosts(hosts, (host, info) => {
        this.latency.set(host, info)
        this.queueEmit()
      })
    } finally {
      this.measuring = false
      this.queueEmit()
    }
  }

  // ---------- подключение ----------

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn)
    this.opChain = run.catch(() => undefined)
    return run
  }

  connect(selection: string): Promise<Result> {
    return this.serialize(() => this.doConnect(selection, { manual: true }))
  }

  disconnect(): Promise<Result> {
    return this.serialize(() => this.doDisconnect(true))
  }

  toggle(): Promise<Result> {
    if (isActivePhase(this.tunnel.phase) || this.tunnel.phase === 'stopping') return this.disconnect()
    const s = this.d.getSettings()
    return this.connect(this.pickStartSelection(s))
  }

  /** Страна для кнопки «Подключить»: выбранная в списке, иначе по настройке «страна по умолчанию». */
  private pickStartSelection(s: Settings): string {
    if (s.selectedCountryId !== 'auto') return s.selectedCountryId
    if (s.defaultCountryId === 'last') return s.last.countryId && this.groups().some((g) => g.id === s.last.countryId) ? s.last.countryId : 'auto'
    if (s.defaultCountryId !== 'auto' && this.groups().some((g) => g.id === s.defaultCountryId)) return s.defaultCountryId
    return 'auto'
  }

  private candidatesFor(selection: string): Candidate[] {
    const groups = selection === 'auto' ? this.groups() : this.groups().filter((g) => g.id === selection)
    return groups.flatMap((group) => group.profiles.map((profile) => ({ group, profile })))
  }

  private rank(cands: Candidate[]): Candidate[] {
    const s = this.d.getSettings()
    const preferred = s.last.profileId ? [s.last.profileId] : []
    const pg = s.defaultCountryId !== 'auto' && s.defaultCountryId !== 'last' ? s.defaultCountryId : null
    return rankCandidates(cands, this.latency, { preferred, preferredGroupId: pg })
  }

  private async doConnect(selection: string, opts: { manual: boolean; keepQueue?: boolean }): Promise<Result> {
    const settings = this.d.getSettings()
    if (opts.manual) {
      this.clearReconnect()
      this.reconnectAttempt = 0
      this.failoverAttempts = 0
      if (settings.selectedCountryId !== selection) await this.d.saveSettings({ ...settings, selectedCountryId: selection })
    }
    const cands = this.candidatesFor(selection)
    if (cands.length === 0) {
      return { ok: false, error: this.groups().length === 0 ? 'Нет доступных конфигураций. Добавьте .conf файлы в папку конфигураций.' : 'Для выбранной страны нет пригодных конфигураций.' }
    }
    const ranked = this.rank(cands)
    // Режим «Авто» допускает переход к следующему кандидату при неудаче; остальные режимы — нет.
    const failoverAllowed = settings.connectionMode === 'auto' || selection === 'auto'
    this.queue = failoverAllowed ? ranked.slice(1, MAX_FAILOVER_ATTEMPTS) : []
    this.userWantsConnected = true
    return this.startProfile(ranked[0]!)
  }

  private async startProfile(c: Candidate): Promise<Result> {
    const settings = this.d.getSettings()
    const mode = effectiveSplitMode(settings)
    const split = splitPayload(mode, settings.split.rules)
    if (mode === 'include' && split.apps.length === 0) {
      return { ok: false, error: 'Режим «Только выбранные приложения через VPN» включён, но список приложений пуст.' }
    }
    if (this.tunnel.phase === 'stopping' || isActivePhase(this.tunnel.phase)) {
      await this.stopTunnel()
    }

    const parsed = await readConfigFile(this.d.getConfigDir(), c.profile.fileName)
    if (!parsed.ok || !parsed.config) {
      this.failImmediate('bad-config', parsed.issues.find((i) => i.severity === 'error')?.message ?? 'Конфигурация недействительна.')
      return { ok: false, error: this.tunnel.error ?? 'Конфигурация недействительна.' }
    }
    const config = buildTunnelConfig(parsed.config, {
      routeMode: process.platform === 'linux' || effectiveKillSwitch(settings) ? 'killswitch' : 'no-killswitch',
      dns: settings.network.dnsMode === 'custom' ? settings.network.dnsServers : undefined,
      mtu: settings.network.mtuMode === 'custom' ? settings.network.mtu : undefined,
      ipv6: settings.network.ipv6
    })
    this.staleAfterSec = handshakeStaleAfterSeconds(parsed.config)
    this.activeProfileId = c.profile.id
    this.activeCountryId = c.group.id
    this.connectedSince = null
    this.degradedSince = null
    this.apply({ type: 'connect-requested', profileId: c.profile.id, now: Date.now() })
    this.d.log.info(`Подключение: ${profileTitle(c.group, c.profile)} (${c.profile.fileName}), режим ${settings.connectionMode}, split=${mode}`)

    try {
      const r = await this.requestHelper({ op: 'connect', config, split, staleAfterSec: this.staleAfterSec, options: { killSwitch: settings.network.killSwitch, allowLan: settings.network.localNetwork } }, 15_000)
      if (!r.ok) {
        this.failImmediate(r.error?.code ?? 'helper-error', r.error?.message ?? 'Служба отклонила запрос.')
        return { ok: false, error: r.error?.message ?? 'Служба отклонила запрос.' }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.failImmediate(e instanceof HelperError ? `helper-${e.code}` : 'helper-error', msg)
      return { ok: false, error: msg }
    }
    this.startPolling()
    return { ok: true }
  }

  private failImmediate(code: string, message: string): void {
    this.tunnel = { ...this.tunnel, phase: 'failed', since: Date.now(), errorCode: code, error: message }
    this.userWantsConnected = false
    this.stopPolling()
    this.queueEmit()
  }

  private async doDisconnect(manual: boolean): Promise<Result> {
    if (manual) {
      this.userWantsConnected = false
      this.clearReconnect()
      this.queue = []
    }
    if (this.tunnel.phase === 'idle') return { ok: true }
    if (this.tunnel.phase === 'failed') {
      // Остатки (адаптер, правила) убираем на стороне службы и сбрасываем состояние.
      await this.requestHelper({ op: 'disconnect' }).catch(() => undefined)
      this.apply({ type: 'reset', now: Date.now() })
      this.afterIdle()
      return { ok: true }
    }
    await this.stopTunnel()
    return { ok: true }
  }

  /** Останавливает туннель и дожидается состояния «остановлен». */
  private async stopTunnel(): Promise<void> {
    this.apply({ type: 'disconnect-requested', now: Date.now() })
    try {
      await this.requestHelper({ op: 'disconnect' }, 10_000)
    } catch (e) {
      this.d.log.warn(`Остановка туннеля: ${e instanceof Error ? e.message : String(e)}`)
    }
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      const st = await this.safeStatus()
      if (!st || st.state === 'stopped') break
      await sleep(400)
    }
    this.apply({ type: 'reset', now: Date.now() })
    this.stopPolling()
    this.afterIdle()
  }

  private afterIdle(): void {
    this.connectedSince = null
    this.degradedSince = null
    this.activeProfileId = null
    this.activeCountryId = null
    this.split = { state: 'off', error: null, activeFlows: 0 }
    this.queueEmit()
    void this.measureLatency()
  }

  // ---------- опрос службы ----------

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
    void this.poll()
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const prev = this.tunnel.phase
      let status: HelperStatus | null = null
      try {
        const r = await this.requestHelper({ op: 'status' }, 4000)
        status = r.status ?? null
      } catch (e) {
        this.apply({ type: 'helper-unreachable', now: Date.now(), message: e instanceof Error ? e.message : 'Служба недоступна.' })
      }
      if (status) {
        this.split = { state: status.split.state, error: status.split.error, activeFlows: status.split.activeFlows }
        this.apply({ type: 'helper-status', status, now: Date.now(), handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS, staleAfterSec: this.staleAfterSec })
      }
      this.onTransition(prev, this.tunnel.phase)
      this.checkDegraded()
    } finally {
      this.polling = false
    }
  }

  private onTransition(prev: TunnelState['phase'], next: TunnelState['phase']): void {
    if (prev === next) return
    const info = this.activeInfo()
    this.d.log.info(`Состояние туннеля: ${prev} → ${next}${this.tunnel.errorCode ? ` (${this.tunnel.errorCode})` : ''}`)
    if (next === 'connected') {
      this.connectedSince = Date.now()
      this.degradedSince = null
      this.reconnectAttempt = 0
      this.failoverAttempts = 0
      const s = this.d.getSettings()
      if (this.activeProfileId && this.activeCountryId) {
        void this.d.saveSettings({ ...s, last: { countryId: this.activeCountryId, profileId: this.activeProfileId } })
      }
      if (prev !== 'degraded') this.d.notify('Подключено', info.countryName ? `Соединение через ${info.countryName} установлено.` : 'Соединение установлено.')
    }
    if (next === 'failed') {
      this.connectedSince = null
      void this.handleFailure(prev)
    }
  }

  private checkDegraded(): void {
    if (this.tunnel.phase === 'degraded') {
      this.degradedSince ??= Date.now()
      if (Date.now() - this.degradedSince > DEGRADED_RECONNECT_MS && this.d.getSettings().reconnectOnLoss && this.userWantsConnected) {
        this.d.log.warn('Рукопожатия нет дольше минуты — переподключаемся.')
        this.degradedSince = null
        void this.serialize(() => this.reconnectNow())
      }
    } else {
      this.degradedSince = null
    }
  }

  private async handleFailure(prevPhase: TunnelState['phase']): Promise<void> {
    const s = this.d.getSettings()
    const wasStarting = prevPhase === 'starting' || prevPhase === 'handshaking'
    // Очистка остатков на стороне службы (адаптер, правила брандмауэра, файл конфигурации).
    await this.requestHelper({ op: 'disconnect' }, 8000).catch(() => undefined)

    if (wasStarting && this.userWantsConnected && this.queue.length > 0 && this.failoverAttempts < MAX_FAILOVER_ATTEMPTS) {
      const next = this.queue.shift()!
      this.failoverAttempts++
      this.d.log.warn(`Профиль не ответил — пробуем следующий: ${profileTitle(next.group, next.profile)}`)
      void this.serialize(async () => {
        await this.waitStopped()
        await this.startProfile(next)
      })
      return
    }
    const info = this.activeInfo()
    if (this.userWantsConnected && s.reconnectOnLoss && !wasStarting && this.reconnectAttempt < RECONNECT_DELAYS_S.length) {
      this.scheduleReconnect()
      this.d.notify('Соединение потеряно', 'Пытаемся переподключиться…')
      return
    }
    if (this.tunnel.errorCode !== 'helper-missing') {
      this.d.notify('Не удалось подключиться', `${info.countryName ?? 'VPN'}: ${this.tunnel.error ?? 'неизвестная ошибка'}`)
    }
  }

  private async waitStopped(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const st = await this.safeStatus()
      if (!st || st.state === 'stopped') return
      await sleep(300)
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    const delay = RECONNECT_DELAYS_S[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_S.length - 1)]! * 1000
    this.reconnectAttempt++
    this.reconnectAt = Date.now() + delay
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAt = null
      void this.serialize(() => this.reconnectNow())
    }, delay)
    this.queueEmit()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAt = null
  }

  private async reconnectNow(): Promise<void> {
    if (!this.userWantsConnected) return
    const s = this.d.getSettings()
    const selection = s.selectedCountryId === 'auto' ? 'auto' : s.selectedCountryId
    this.d.log.info(`Переподключение (попытка ${this.reconnectAttempt + 1})`)
    await this.doConnect(selection, { manual: false })
  }

  /** После выхода из сна: проверить рукопожатие и при необходимости переподключиться сразу. */
  onResume(): void {
    if (!this.userWantsConnected) return
    setTimeout(() => {
      void this.poll().then(() => {
        const p = this.tunnel.phase
        if ((p === 'degraded' || p === 'failed') && this.d.getSettings().reconnectOnLoss) {
          this.reconnectAttempt = 0
          this.d.log.info('Выход из сна: соединение не восстановилось — переподключаемся.')
          void this.serialize(() => this.reconnectNow())
        }
      })
    }, 3000)
  }

  /** Сеть появилась после отсутствия. */
  onNetworkRestored(): void {
    const p = this.tunnel.phase
    if (this.userWantsConnected && (p === 'degraded' || p === 'failed') && this.d.getSettings().reconnectOnLoss) {
      this.clearReconnect()
      this.reconnectAttempt = 0
      void this.serialize(() => this.reconnectNow())
    }
  }

  // ---------- настройки ----------

  async setSettings(patch: SettingsPatch): Promise<Result> {
    const prev = this.d.getSettings()
    const next = applySettingsPatch(prev, patch)
    await this.d.saveSettings(next)
    const folderChanged = prev.app.configDir !== next.app.configDir
    if (folderChanged) await this.rescan()
    const networkChanged = NETWORK_KEYS.some((k) => JSON.stringify(prev.network[k]) !== JSON.stringify(next.network[k]))
    const splitChanged = JSON.stringify(prev.split) !== JSON.stringify(next.split) || prev.connectionMode !== next.connectionMode
    if ((networkChanged || splitChanged) && isActivePhase(this.tunnel.phase) && this.userWantsConnected) {
      // Параметры туннеля применяются только при подключении: переподключаемся один раз после паузы.
      if (this.applyTimer) clearTimeout(this.applyTimer)
      this.applyTimer = setTimeout(() => {
        this.d.log.info('Изменены параметры сети/раздельного туннелирования — переподключаемся.')
        void this.serialize(() => this.reconnectNow())
      }, 1500)
    }
    this.queueEmit()
    return { ok: true }
  }

  async selectCountry(id: string): Promise<Result> {
    const s = this.d.getSettings()
    if (id !== 'auto' && !this.groups().some((g) => g.id === id)) return { ok: false, error: 'Страна не найдена.' }
    await this.d.saveSettings({ ...s, selectedCountryId: id })
    this.queueEmit()
    return { ok: true }
  }

  // ---------- служба ----------

  async probeHelper(): Promise<void> {
    try {
      const r = await this.requestHelper({ op: 'hello' }, 3000)
      this.helper = r.ok ? { state: 'ok', version: r.version ?? '?' } : { state: 'error', message: r.error?.message ?? 'Служба вернула ошибку.' }
    } catch (e) {
      if (e instanceof HelperError && e.code === 'unsupported') this.helper = { state: 'unsupported', message: e.message }
      else if (e instanceof HelperError && e.code === 'missing') this.helper = { state: 'missing', message: e.message }
      else this.helper = { state: 'error', message: e instanceof Error ? e.message : 'Ошибка связи со службой.' }
    }
    this.queueEmit()
  }

  async recoverNetwork(): Promise<Result> {
    return this.serialize(async () => {
      this.userWantsConnected = false
      this.clearReconnect()
      this.stopPolling()
      try {
        const r = await this.requestHelper({ op: 'recover' }, 60_000)
        this.apply({ type: 'reset', now: Date.now() })
        this.afterIdle()
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error?.message ?? 'Не удалось восстановить сеть.' }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : 'Служба недоступна.' }
      }
    })
  }

  async logs(tail: number): Promise<string[]> {
    try {
      return (await this.requestHelper({ op: 'logs', tail }, 6000)).logs ?? []
    } catch {
      return []
    }
  }

  helperVersion(): string | null {
    return this.helper.state === 'ok' ? this.helper.version : null
  }

  /** Перед выходом из приложения: отключить туннель (но не дольше таймаута). */
  async shutdown(): Promise<void> {
    if (this.periodic) clearInterval(this.periodic)
    this.userWantsConnected = false
    this.clearReconnect()
    if (this.tunnel.phase !== 'idle') {
      await Promise.race([this.serialize(() => this.doDisconnect(true)), sleep(15_000)])
    }
    this.stopPolling()
  }

  private async requestHelper(req: Parameters<typeof helperRequest>[0], timeout?: number): Promise<HelperResponse> {
    try {
      const r = await helperRequest(req, timeout)
      if (this.helper.state !== 'ok') {
        this.helper = { state: 'ok', version: r.version ?? '?' }
        this.queueEmit()
      }
      return r
    } catch (e) {
      if (e instanceof HelperError && (e.code === 'missing' || e.code === 'unsupported')) {
        this.helper = { state: e.code, message: e.message }
        this.queueEmit()
      }
      throw e
    }
  }

  private async safeStatus(): Promise<HelperStatus | null> {
    try {
      return (await this.requestHelper({ op: 'status' }, 4000)).status ?? null
    } catch {
      return null
    }
  }

  // ---------- состояние и снимок ----------

  private apply(ev: TunnelEvent): void {
    this.tunnel = reduceTunnel(this.tunnel, ev)
    this.queueEmit()
  }

  private activeInfo(): ActiveInfo {
    const c = this.findProfile(this.activeProfileId)
    return {
      countryId: c?.group.id ?? this.activeCountryId,
      countryName: c?.group.nameRu ?? null,
      countryCode: c?.group.code ?? null,
      profileTitle: c ? profileTitle(c.group, c.profile) : null
    }
  }

  private profileView(group: CountryGroup, p: Profile): ProfileView {
    const key = endpointKey(p)
    const latency = (key ? this.latency.get(key) : undefined) ?? { state: 'unknown' as const, rttMs: null, measuredAt: null }
    return {
      id: p.id, fileName: p.fileName, title: profileTitle(group, p), label: p.label,
      awgVersion: p.summary?.awgVersion ?? '?', latency, quality: qualityOf(latency),
      warnings: p.issues.filter((i) => i.severity === 'warning').map((i) => i.message)
    }
  }

  private libraryView(): LibraryView {
    const scan = this.scan
    if (!scan) return { configDir: this.d.getConfigDir(), exists: false, dirError: null, countries: [], invalid: [], duplicateFiles: [], totalFiles: 0, scannedAt: 0 }
    const countries: CountryView[] = scan.library.countries.map((g) => {
      const profiles = g.profiles.map((p) => this.profileView(g, p))
      const measured = profiles.filter((p) => p.latency.state === 'ok' && p.latency.rttMs !== null)
      const best = measured.length ? Math.min(...measured.map((p) => p.latency.rttMs!)) : null
      const bestProfile = best === null ? undefined : measured.find((p) => p.latency.rttMs === best)
      return { id: g.id, code: g.code, nameRu: g.nameRu, custom: g.custom, profiles, bestRttMs: best, quality: bestProfile ? bestProfile.quality : 'unknown' }
    })
    return {
      configDir: scan.dir, exists: scan.exists, dirError: scan.dirError, countries,
      invalid: scan.library.invalid.map((p) => ({ fileName: p.fileName, issues: p.issues })),
      duplicateFiles: scan.library.duplicates.map((p) => p.fileName),
      totalFiles: scan.library.totalFiles, scannedAt: Date.now()
    }
  }

  snapshot(): AppSnapshot {
    return {
      platform: process.platform,
      appVersion: this.d.appVersion,
      tunnel: this.tunnel,
      active: this.activeInfo(),
      connectedSince: this.connectedSince,
      library: this.libraryView(),
      settings: this.d.getSettings(),
      helper: this.helper,
      split: this.split,
      reconnect: this.reconnectAt ? { attempt: this.reconnectAttempt, nextInMs: Math.max(0, this.reconnectAt - Date.now()) } : null,
      measuring: this.measuring
    }
  }

  queueEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('snapshot', this.snapshot())
    }, 120)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

