import { describe, expect, it } from 'vitest'
import { getAllCountryCodes, getCountryNames, identifyFromFileName, matchCountry } from '../src/shared/countries'

const code = (name: string): string | null => matchCountry(name.replace(/\.conf$/i, ''))?.code ?? null

describe('определение страны по имени файла', () => {
  it('распознаёт обычные английские названия', () => {
    const expected: Record<string, string> = {
      albania: 'AL', australia: 'AU', brazil: 'BR', bulgaria: 'BG', canada: 'CA', france: 'FR', germany: 'DE',
      ireland: 'IE', italy: 'IT', lithuania: 'LT', mexico: 'MX', netherlands: 'NL', norway: 'NO', portugal: 'PT',
      romania: 'RO', spain: 'ES', japan: 'JP', usa: 'US'
    }
    for (const [name, c] of Object.entries(expected)) expect(code(name), name).toBe(c)
  })

  it('не зависит от регистра и разделителей', () => {
    for (const n of ['United Kingdom', 'united_kingdom', 'UNITED-KINGDOM', 'UnitedKingdom', 'united.kingdom', 'UK', 'uk', 'Great Britain', 'england']) {
      expect(code(n), n).toBe('GB')
    }
    for (const n of ['hong-kong', 'Hong Kong', 'hong_kong', 'HongKong', 'HK']) expect(code(n), n).toBe('HK')
  })

  it('понимает коды ISO alpha-2 и alpha-3', () => {
    expect(code('de')).toBe('DE')
    expect(code('JPN')).toBe('JP')
    expect(code('fr3')).toBe('FR')
    expect(code('NLD')).toBe('NL')
  })

  it('понимает псевдонимы', () => {
    expect(code('USA')).toBe('US')
    expect(code('america')).toBe('US')
    expect(code('UAE')).toBe('AE')
    expect(code('holland')).toBe('NL')
    expect(code('czech republic')).toBe('CZ')
    expect(code('south-korea')).toBe('KR')
    expect(code('turkey')).toBe('TR')
    expect(code('Deutschland')).toBe('DE')
  })

  it('понимает русские и родные названия (Unicode)', () => {
    expect(code('Япония')).toBe('JP')
    expect(code('германия')).toBe('DE')
    expect(code('Нидерланды')).toBe('NL')
    expect(code('日本')).toBe('JP')
    expect(code('Österreich')).toBe('AT')
    expect(code('Україна')).toBe('UA')
  })

  it('отделяет описательный суффикс сервера', () => {
    expect(matchCountry('Germany-2')).toEqual({ code: 'DE', label: '2' })
    expect(matchCountry('germany_frankfurt')).toEqual({ code: 'DE', label: 'frankfurt' })
    expect(matchCountry('us-east-3')).toEqual({ code: 'US', label: 'east 3' })
    expect(matchCountry('United Kingdom London 1')?.code).toBe('GB')
  })

  it('двухбуквенный код не срабатывает посреди имени', () => {
    // «us» здесь — часть метки, а страна определяется по слову «germany»
    expect(code('relay-us-germany')).toBe('DE')
    expect(code('office-server')).toBeNull()
  })

  it('неизвестные имена становятся пользовательскими профилями', () => {
    const id = identifyFromFileName('Atlantis_Prime.conf')
    expect(id.code).toBeNull()
    expect(id.groupId.startsWith('custom:')).toBe(true)
    expect(id.nameRu).toBe('Atlantis Prime')
  })
})

describe('русские названия и флаги', () => {
  it('возвращает ожидаемые русские названия', () => {
    const expected: Record<string, string> = {
      AL: 'Албания', AU: 'Австралия', BR: 'Бразилия', BG: 'Болгария', CA: 'Канада', FR: 'Франция', DE: 'Германия',
      GB: 'Великобритания', HK: 'Гонконг', IE: 'Ирландия', IT: 'Италия', JP: 'Япония', LT: 'Литва', MX: 'Мексика',
      NL: 'Нидерланды', NO: 'Норвегия', PT: 'Португалия', RO: 'Румыния', ES: 'Испания', US: 'США', AT: 'Австрия'
    }
    for (const [c, ru] of Object.entries(expected)) expect(getCountryNames(c)?.ru, c).toBe(ru)
  })

  it('Japan.conf превращается в «Япония» с кодом JP (для флага 🇯🇵)', () => {
    const id = identifyFromFileName('Japan.conf')
    expect(id.code).toBe('JP')
    expect(id.nameRu).toBe('Япония')
  })

  it('для каждого кода ISO есть русское название', () => {
    for (const c of getAllCountryCodes()) {
      const n = getCountryNames(c)
      expect(n?.ru && n.ru !== c, c).toBeTruthy()
    }
  })
})
