import { describe, expect, it } from 'vitest'
import { effectiveSplitMode, applySettingsPatch, DEFAULT_SETTINGS, sanitizeSettings, effectiveKillSwitch } from '../src/shared/settings'
import { normalizeExePath, splitPayload, validateSplitRule, validateSplitRules } from '../src/shared/split'

describe('правила раздельного туннелирования', () => {
  it('нормализует полные пути к .exe', () => {
    expect(normalizeExePath('C:\\Program Files\\App\\app.exe')).toBe('C:\\Program Files\\App\\app.exe')
    expect(normalizeExePath('"C:/Program Files/App//app.EXE"')).toBe('C:\\Program Files\\App\\app.EXE')
    expect(normalizeExePath('\\\\srv\\share\\tools\\x.exe')).toBe('\\\\srv\\share\\tools\\x.exe')
  })

  it('отвергает небезопасные и неполные пути', () => {
    for (const bad of [
      'chrome.exe', '.\\app.exe', 'C:app.exe', 'C:\\Windows\\..\\evil.exe', 'C:\\a\\b.txt', 'C:\\a\\*.exe', 'C:\\a\\b?.exe',
      '%ProgramFiles%\\x.exe', '\\\\?\\C:\\x.exe', '\\\\.\\pipe\\x.exe', 'C:\\a\\.exe', '', '   ', 'C:\\a\\' + 'x'.repeat(300) + '.exe',
      'C:\\a|b\\c.exe', 'http://x/y.exe', '\\\\server\\x.exe'
    ]) {
      expect(normalizeExePath(bad), bad).toBeNull()
    }
    expect(normalizeExePath(42 as unknown as string)).toBeNull()
  })

  it('идентифицирует приложение по полному пути, а не по имени', () => {
    const { valid, errors } = validateSplitRules([
      { exePath: 'C:\\A\\chrome.exe', name: 'Chrome' },
      { exePath: 'D:\\Portable\\chrome.exe', name: 'Chrome (portable)' },
      { exePath: 'c:\\a\\CHROME.exe' }
    ])
    expect(valid.map((r) => r.exePath)).toEqual(['C:\\A\\chrome.exe', 'D:\\Portable\\chrome.exe'])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('уже добавлено')
  })

  it('понятные ошибки и устойчивость к мусору', () => {
    expect(validateSplitRule(null).rule).toBeNull()
    expect(validateSplitRule({}).error).toContain('путь')
    expect(validateSplitRule({ exePath: 'x' }).error).toContain('полный путь')
    expect(validateSplitRules('x').errors).toHaveLength(1)
    const many = Array.from({ length: 250 }, (_, i) => ({ exePath: `C:\\a\\app${i}.exe` }))
    const r = validateSplitRules(many)
    expect(r.valid).toHaveLength(200)
  })

  it('имя по умолчанию — имя файла; отключённые правила не уходят в службу', () => {
    const { valid } = validateSplitRules([{ exePath: 'C:\\A\\one.exe' }, { exePath: 'C:\\A\\two.exe', enabled: false }])
    expect(valid[0]!.name).toBe('one.exe')
    expect(splitPayload('bypass', valid)).toEqual({ mode: 'bypass', apps: ['C:\\A\\one.exe'] })
    expect(splitPayload('all', valid)).toEqual({ mode: 'all', apps: [] })
  })

  it('правила действуют только в режиме «Адаптивный»', () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { split: { mode: 'bypass' } })
    expect(s.split.mode).toBe('bypass')
    expect(effectiveSplitMode(s)).toBe('all')
    expect(effectiveSplitMode(applySettingsPatch(s, { connectionMode: 'adaptive' }))).toBe('bypass')
  })
})

describe('настройки', () => {
  it('мусор из файла превращается в значения по умолчанию', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    const s = sanitizeSettings({ connectionMode: 'turbo', network: { mtu: 99999, dnsServers: ['1.1.1.1', 'rm -rf /', '::1'], ipv6: 'x' }, app: { theme: 'neon', configDir: 5 } })
    expect(s.connectionMode).toBe(DEFAULT_SETTINGS.connectionMode)
    expect(s.network.mtu).toBe(DEFAULT_SETTINGS.network.mtu)
    expect(s.network.dnsServers).toEqual(['1.1.1.1', '::1'])
    expect(s.network.ipv6).toBe('tunnel')
    expect(s.app.theme).toBe('dark')
    expect(s.app.configDir).toBeNull()
  })

  it('patch меняет только известные поля', () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { autoConnect: true, evil: 1, network: { killSwitch: false, __proto__: { polluted: true } } })
    expect(s.autoConnect).toBe(true)
    expect(s.network.killSwitch).toBe(false)
    expect((s as unknown as Record<string, unknown>).evil).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('доступ к локальной сети отключает kill switch', () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { network: { localNetwork: true } })
    expect(s.network.killSwitch).toBe(true)
    expect(effectiveKillSwitch(s)).toBe(false)
    expect(effectiveKillSwitch(DEFAULT_SETTINGS)).toBe(true)
  })
})

describe('пути POSIX (Linux)', () => {
  it('принимает абсолютные пути и нормализует их', () => {
    expect(normalizeExePath('/usr/bin/firefox')).toBe('/usr/bin/firefox')
    expect(normalizeExePath('/opt//Telegram/Telegram/')).toBe('/opt/Telegram/Telegram')
    expect(normalizeExePath('"/home/u/My App/run"')).toBe('/home/u/My App/run')
  })
  it('отвергает небезопасные', () => {
    for (const bad of ['/', '/usr/../bin/sh', '/usr/./bin/x', '/usr/bin/*', '/tmp/a\nb', 'usr/bin/x', '/a/b?c']) expect(normalizeExePath(bad), bad).toBeNull()
  })
  it('регистр в POSIX значим, в Windows — нет', () => {
    const { valid } = validateSplitRules([{ exePath: '/usr/bin/App' }, { exePath: '/usr/bin/app' }, { exePath: 'C:\\A\\x.exe' }, { exePath: 'c:\\a\\X.EXE' }])
    expect(valid.map((r) => r.exePath)).toEqual(['/usr/bin/App', '/usr/bin/app', 'C:\\A\\x.exe'])
    expect(validateSplitRule({ exePath: '/usr/bin/firefox' }).rule?.name).toBe('firefox')
  })
})
