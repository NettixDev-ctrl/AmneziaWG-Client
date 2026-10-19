import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfigFile, resolveConfigDir, scanConfigDir } from '../src/main/scanner'
import { sampleConfig } from './fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-scan-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('сканирование папки конфигураций', () => {
  it('находит .conf без учёта регистра расширения и игнорирует прочее', async () => {
    writeFileSync(join(dir, 'Albania.conf'), sampleConfig({ seed: '1' }))
    writeFileSync(join(dir, 'JAPAN.CONF'), sampleConfig({ seed: '2' }))
    writeFileSync(join(dir, 'readme.txt'), 'hello')
    writeFileSync(join(dir, 'manifest.jsonl'), '{}')
    mkdirSync(join(dir, 'nested.conf'))
    const r = await scanConfigDir(dir)
    expect(r.exists).toBe(true)
    expect(r.library.countries.map((c) => c.nameRu)).toEqual(['Албания', 'Япония'])
    expect(r.library.invalid.map((p) => p.fileName)).toEqual(['nested.conf'])
  })

  it('добавленный файл появляется, удалённый — исчезает', async () => {
    writeFileSync(join(dir, 'germany.conf'), sampleConfig({ seed: '1' }))
    expect((await scanConfigDir(dir)).library.countries).toHaveLength(1)
    writeFileSync(join(dir, 'Japan.conf'), sampleConfig({ seed: '2' }))
    const added = await scanConfigDir(dir)
    expect(added.library.countries.map((c) => `${c.code}:${c.nameRu}`)).toContain('JP:Япония')
    rmSync(join(dir, 'germany.conf'))
    expect((await scanConfigDir(dir)).library.countries.map((c) => c.code)).toEqual(['JP'])
  })

  it('поддерживает Unicode-имена файлов', async () => {
    writeFileSync(join(dir, 'Япония.conf'), sampleConfig({ seed: '1' }))
    writeFileSync(join(dir, '日本-2.conf'), sampleConfig({ seed: '2' }))
    const r = await scanConfigDir(dir)
    expect(r.library.countries).toHaveLength(1)
    expect(r.library.countries[0]!.code).toBe('JP')
    expect(r.library.countries[0]!.profiles).toHaveLength(2)
  })

  it('отсутствующая папка — пустое состояние, а не ошибка', async () => {
    const r = await scanConfigDir(join(dir, 'нет-такой'))
    expect(r.exists).toBe(false)
    expect(r.library.countries).toEqual([])
    expect(r.dirError).toBeNull()
  })

  it('пустая папка даёт пустой список', async () => {
    const r = await scanConfigDir(dir)
    expect(r.exists).toBe(true)
    expect(r.library.totalFiles).toBe(0)
  })

  it('не следует по символическим ссылкам и не читает вне папки', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'awg-outside-'))
    try {
      writeFileSync(join(outside, 'secret.conf'), sampleConfig())
      symlinkSync(join(outside, 'secret.conf'), join(dir, 'france.conf'))
      const r = await scanConfigDir(dir)
      expect(r.library.countries).toHaveLength(0)
      expect(r.library.invalid[0]!.issues[0]!.code).toBe('symlink')
      expect((await readConfigFile(dir, '../x.conf')).issues[0]!.code).toBe('bad-path')
      expect((await readConfigFile(dir, 'sub/x.conf')).issues[0]!.code).toBe('bad-path')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('отклоняет слишком большие файлы без чтения', async () => {
    writeFileSync(join(dir, 'spain.conf'), 'a'.repeat(70_000))
    const r = await scanConfigDir(dir)
    expect(r.library.invalid[0]!.issues[0]!.code).toBe('too-large')
  })

  it('читает UTF-16 и UTF-8 с BOM', async () => {
    const text = sampleConfig({ seed: '9' })
    writeFileSync(join(dir, 'italy.conf'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    writeFileSync(join(dir, 'spain.conf'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sampleConfig({ seed: '8' }))]))
    const r = await scanConfigDir(dir)
    expect(r.library.countries.map((c) => c.code).sort()).toEqual(['ES', 'IT'])
  })
})

describe('выбор папки', () => {
  it('приоритет: переменная окружения → настройка → «configs» рядом с программой', () => {
    const base = { exeDir: '/opt/vpn', configured: null }
    expect(resolveConfigDir({ ...base, env: '/tmp/x' })).toBe('/tmp/x')
    expect(resolveConfigDir({ ...base, configured: '/home/u/cfg' })).toBe('/home/u/cfg')
    expect(resolveConfigDir(base)).toBe(join('/opt/vpn', 'configs'))
  })
})
