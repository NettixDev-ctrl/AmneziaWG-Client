import { describe, expect, it } from 'vitest'
import { parseAwgConfig } from '../src/shared/awgConfig'
import { buildLibrary, profileIdFor, type ScannedFile } from '../src/shared/profiles'
import { sampleConfig } from './fixtures'

const file = (fileName: string, text: string): ScannedFile => ({ fileName, parsed: parseAwgConfig(text) })

describe('библиотека профилей', () => {
  it('группирует несколько конфигураций одной страны', () => {
    const lib = buildLibrary([
      file('Germany.conf', sampleConfig({ seed: '1' })),
      file('Germany-2.conf', sampleConfig({ seed: '2' })),
      file('france.conf', sampleConfig({ seed: '3' }))
    ])
    expect(lib.countries.map((c) => c.nameRu)).toEqual(['Германия', 'Франция'])
    const de = lib.countries.find((c) => c.code === 'DE')!
    expect(de.profiles.map((p) => p.fileName)).toEqual(['Germany-2.conf', 'Germany.conf'])
    expect(de.profiles.find((p) => p.fileName === 'Germany-2.conf')?.label).toBe('2')
  })

  it('сворачивает дубликаты внутри страны', () => {
    const same = sampleConfig({ seed: 'dup' })
    const lib = buildLibrary([file('germany.conf', same), file('germany-copy.conf', same + '\n# комментарий\n')])
    expect(lib.countries[0]!.profiles).toHaveLength(1)
    expect(lib.duplicates).toHaveLength(1)
    expect(lib.duplicates[0]!.duplicateOf).toBe(lib.countries[0]!.profiles[0]!.id)
  })

  it('одинаковые конфигурации в разных странах не сворачиваются, но помечаются', () => {
    const same = sampleConfig({ seed: 'same' })
    const lib = buildLibrary([file('france.conf', same), file('germany.conf', same)])
    expect(lib.countries).toHaveLength(2)
    expect(lib.countries.flatMap((c) => c.profiles).some((p) => p.issues.some((i) => i.code === 'duplicate-other-country'))).toBe(true)
  })

  it('неисправные файлы не попадают в список стран', () => {
    const lib = buildLibrary([file('spain.conf', 'мусор'), file('italy.conf', sampleConfig())])
    expect(lib.countries.map((c) => c.code)).toEqual(['IT'])
    expect(lib.invalid.map((p) => p.fileName)).toEqual(['spain.conf'])
  })

  it('неизвестные страны становятся пользовательскими группами', () => {
    const lib = buildLibrary([file('Atlantis.conf', sampleConfig())])
    expect(lib.countries[0]!.custom).toBe(true)
    expect(lib.countries[0]!.nameRu).toBe('Atlantis')
  })

  it('идентификатор профиля стабилен и не зависит от регистра', () => {
    expect(profileIdFor('Germany.conf')).toBe(profileIdFor('germany.CONF'))
  })

  it('сортирует страны по русскому названию', () => {
    const lib = buildLibrary(['usa', 'albania', 'japan', 'brazil'].map((n, i) => file(`${n}.conf`, sampleConfig({ seed: String(i) }))))
    expect(lib.countries.map((c) => c.nameRu)).toEqual(['Албания', 'Бразилия', 'США', 'Япония'])
  })
})
