import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySettingsPatch, DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { HelperStatus } from '../src/shared/tunnelState'
import { sampleConfig } from './fixtures'

// ---- «служба» в памяти: реализует протокол, который реальная служба отдаёт через канал ----
interface FakeHelper {
  status: HelperStatus
  calls: Array<{ op: string; config?: string; split?: { mode: string; apps: string[] } }>
  missing: boolean
  onConnect: () => void
}
const fake: FakeHelper = { status: idle(), calls: [], missing: false, onConnect: () => undefined }

function idle(): HelperStatus {
  return { state: 'stopped', handshakeAgeSec: null, rxBytes: 0, txBytes: 0, errorCode: null, error: null, split: { state: 'off', error: null, activeFlows: 0 } }
}

vi.mock('../src/main/helperClient', () => {
  class HelperError extends Error {
    constructor(public code: string, message: string) {
      super(message)
    }
  }
  return {
    HelperError,
    helperRequest: async (req: { op: string; config?: string; split?: { mode: string; apps: string[] } }) => {
      fake.calls.push({ op: req.op, config: req.config, split: req.split })
      if (fake.missing) throw new HelperError('missing', 'Служба Privata VPN не установлена или не запущена.')
      switch (req.op) {
        case 'hello': return { ok: true, version: 'test', status: fake.status }
        case 'status': return { ok: true, status: fake.status }
        case 'connect': fake.status = { ...idle(), state: 'starting' }; fake.onConnect(); return { ok: true, status: fake.status }
        case 'disconnect': fake.status = idle(); return { ok: true, status: fake.status }
        case 'recover': fake.status = idle(); return { ok: true }
        default: return { ok: true, logs: [] }
      }
    }
  }
})
vi.mock('../src/main/latency', () => ({ measureHosts: async () => undefined, pingHost: async () => ({ state: 'unknown', rttMs: null, measuredAt: null }) }))

import { Controller } from '../src/main/controller'
import { Logger } from '../src/main/logger'

let dir: string
let settings: Settings
let notifications: string[]
let controller: Controller

function make(): Controller {
  return new Controller({
    log: new Logger(), getSettings: () => settings, saveSettings: async (s) => { settings = s },
    getConfigDir: () => dir, notify: (t, b) => notifications.push(`${t}: ${b}`), appVersion: 'test'
  })
}
const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}
const phase = (): string => controller.snapshot().tunnel.phase

beforeEach(async () => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'awg-ctl-'))
  writeFileSync(join(dir, 'Germany.conf'), sampleConfig({ seed: 'de', endpoint: '203.0.113.1:51821', extraInterface: ['PostUp = calc.exe'] }))
  writeFileSync(join(dir, 'France.conf'), sampleConfig({ seed: 'fr', endpoint: '203.0.113.2:51821' }))
  settings = applySettingsPatch(DEFAULT_SETTINGS, { connectionMode: 'fast' })
  notifications = []
  fake.status = idle()
  fake.calls = []
  fake.missing = false
  fake.onConnect = () => undefined
  controller = make()
  await controller.init()
  await tick(10)
})
afterEach(async () => {
  await controller.shutdown().catch(() => undefined)
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('контроллер подключения (служба в памяти)', () => {
  it('«Подключено» только после свежего рукопожатия, а не после запуска службы', async () => {
    expect((await controller.connect('DE')).ok).toBe(true)
    fake.status = { ...idle(), state: 'running', handshakeAgeSec: null }
    await tick(1100)
    expect(phase()).toBe('handshaking')
    expect(notifications).toHaveLength(0)
    fake.status = { ...idle(), state: 'running', handshakeAgeSec: 1.5, rxBytes: 10, txBytes: 20 }
    await tick(1100)
    expect(phase()).toBe('connected')
    expect(controller.snapshot().active.countryName).toBe('Германия')
    expect(notifications.some((n) => n.startsWith('Подключено'))).toBe(true)
    expect(settings.last.countryId).toBe('DE')
  })

  it('в службу уходит очищенная конфигурация: без скриптов, с kill switch по умолчанию', async () => {
    await controller.connect('DE')
    const c = fake.calls.find((x) => x.op === 'connect')!
    expect(c.config).toContain('AllowedIPs = 0.0.0.0/0, ::/0')
    expect(c.config).toContain('HeaderProtectionKey =')
    expect(c.config).not.toMatch(/PostUp|calc\.exe/)
    expect(c.split).toEqual({ mode: 'all', apps: [] })
  })

  it('раздельное туннелирование передаётся только в режиме «Адаптивный»', async () => {
    const rules = [{ id: 'a', exePath: 'C:\\Apps\\one.exe', name: 'one', enabled: true }, { id: 'b', exePath: 'C:\\Apps\\two.exe', name: 'two', enabled: false }]
    await controller.setSettings({ split: { mode: 'bypass', rules } })
    await controller.connect('DE')
    expect(fake.calls.find((x) => x.op === 'connect')!.split).toEqual({ mode: 'all', apps: [] })
    await controller.disconnect()
    fake.calls = []
    await controller.setSettings({ connectionMode: 'adaptive' })
    await controller.connect('DE')
    expect(fake.calls.find((x) => x.op === 'connect')!.split).toEqual({ mode: 'bypass', apps: ['C:\\Apps\\one.exe'] })
  })

  it('режим «только выбранные» без приложений не запускается', async () => {
    await controller.setSettings({ connectionMode: 'adaptive', split: { mode: 'include', rules: [] } })
    const r = await controller.connect('DE')
    expect(r.ok).toBe(false)
    expect(fake.calls.some((x) => x.op === 'connect')).toBe(false)
  })

  it.skipIf(process.platform === 'linux')('без kill switch маршруты /0 заменяются на /1', async () => {
    await controller.setSettings({ network: { localNetwork: true } } as never)
    await controller.connect('DE')
    expect(fake.calls.find((x) => x.op === 'connect')!.config).toContain('AllowedIPs = 0.0.0.0/1, 128.0.0.0/1, ::/1, 8000::/1')
  })

  it('таймаут рукопожатия → ошибка и уведомление, служба очищается', async () => {
    await controller.connect('DE')
    fake.status = { ...idle(), state: 'running' }
    await tick(32_000)
    expect(phase()).toBe('failed')
    expect(controller.snapshot().tunnel.errorCode).toBe('handshake-timeout')
    expect(fake.calls.filter((x) => x.op === 'disconnect').length).toBeGreaterThan(0)
    expect(notifications.some((n) => n.startsWith('Не удалось подключиться'))).toBe(true)
  })

  it('режим «Авто» переходит к следующему серверу, если первый не отвечает', async () => {
    await controller.setSettings({ connectionMode: 'auto' })
    await controller.connect('auto')
    const first = fake.calls.filter((x) => x.op === 'connect')
    expect(first).toHaveLength(1)
    fake.status = { ...idle(), state: 'running' } // службы нет рукопожатия
    await tick(32_000)
    await tick(3000)
    const all = fake.calls.filter((x) => x.op === 'connect')
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[1]!.config).not.toBe(all[0]!.config)
  })

  it('служба не установлена → честная ошибка, а не «подключено»', async () => {
    fake.missing = true
    const r = await controller.connect('DE')
    expect(r.ok).toBe(false)
    expect(phase()).toBe('failed')
    expect(controller.snapshot().tunnel.errorCode).toBe('helper-missing')
    expect(controller.snapshot().helper.state).toBe('missing')
  })

  it('отключение: служба останавливается, состояние возвращается в «Отключено»', async () => {
    await controller.connect('DE')
    fake.status = { ...idle(), state: 'running', handshakeAgeSec: 1 }
    await tick(1100)
    expect(phase()).toBe('connected')
    const p = controller.disconnect()
    await tick(1000)
    expect((await p).ok).toBe(true)
    expect(phase()).toBe('idle')
    expect(fake.calls.some((x) => x.op === 'disconnect')).toBe(true)
  })

  it('неожиданная остановка службы → ошибка и запланированное переподключение', async () => {
    await controller.connect('DE')
    fake.status = { ...idle(), state: 'running', handshakeAgeSec: 1 }
    await tick(1100)
    expect(phase()).toBe('connected')
    fake.status = idle() // служба внезапно остановилась
    await tick(1100)
    expect(phase()).toBe('failed')
    expect(controller.snapshot().reconnect).not.toBeNull()
    fake.calls = []
    fake.onConnect = () => undefined
    await tick(2500)
    await vi.waitFor(() => expect(fake.calls.some((x) => x.op === 'connect')).toBe(true), { timeout: 5000, interval: 25 })
  })

  it('переключение страны выполняется как остановка + новый запуск, без параллельных туннелей', async () => {
    await controller.connect('DE')
    fake.status = { ...idle(), state: 'running', handshakeAgeSec: 1 }
    await tick(1100)
    fake.calls = []
    const p = controller.connect('FR')
    await tick(1500)
    await p
    const ops = fake.calls.map((c) => c.op).filter((o) => o === 'disconnect' || o === 'connect')
    expect(ops.indexOf('disconnect')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('disconnect')).toBeLessThan(ops.indexOf('connect'))
    expect(controller.snapshot().active.countryId).toBe('FR')
  })

  it('добавленный файл появляется в списке без перезапуска', async () => {
    expect(controller.snapshot().library.countries.map((c) => c.id).sort()).toEqual(['DE', 'FR'])
    writeFileSync(join(dir, 'Japan.conf'), sampleConfig({ seed: 'jp' }))
    await controller.rescan()
    const jp = controller.snapshot().library.countries.find((c) => c.id === 'JP')
    expect(jp?.nameRu).toBe('Япония')
  })
})
