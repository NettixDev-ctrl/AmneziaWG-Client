/**
 * Определение страны по имени файла конфигурации.
 *
 * Никакого жёстко заданного списка серверов здесь нет: список стран в приложении всегда
 * строится из найденных файлов. Модуль лишь отвечает на вопрос «какой стране соответствует
 * имя файла» на основе кодов ISO 3166-1, локализованных названий (i18n-iso-countries,
 * данные ICU) и небольшой таблицы общеупотребительных псевдонимов.
 */
import countries from 'i18n-iso-countries'
import en from 'i18n-iso-countries/langs/en.json'
import ru from 'i18n-iso-countries/langs/ru.json'

countries.registerLocale(en)
countries.registerLocale(ru)

export interface CountryMatch {
  /** Код ISO 3166-1 alpha-2 в верхнем регистре. */
  code: string
  /** Оставшаяся после распознавания часть имени («2», «Frankfurt», …). */
  label: string
}

export interface CountryNames {
  code: string
  ru: string
  en: string
}

/** Короткие русские названия вместо длинных официальных. */
const RU_OVERRIDES: Record<string, string> = {
  US: 'США',
  GB: 'Великобритания',
  AE: 'ОАЭ',
  KR: 'Южная Корея',
  KP: 'Северная Корея',
  CZ: 'Чехия',
  RU: 'Россия',
  BY: 'Беларусь',
  MD: 'Молдова',
  MK: 'Северная Македония',
  TW: 'Тайвань',
  HK: 'Гонконг',
  MO: 'Макао',
  VN: 'Вьетнам',
  TR: 'Турция',
  LA: 'Лаос',
  IR: 'Иран',
  BO: 'Боливия',
  VE: 'Венесуэла',
  TZ: 'Танзания',
  PS: 'Палестина',
  SZ: 'Эсватини',
  CV: 'Кабо-Верде',
  CI: 'Кот-д’Ивуар',
  VA: 'Ватикан',
  BA: 'Босния и Герцеговина',
  NL: 'Нидерланды',
  SY: 'Сирия',
  BN: 'Бруней',
  CD: 'ДР Конго',
  CG: 'Республика Конго',
  FM: 'Микронезия',
  TL: 'Восточный Тимор',
  MM: 'Мьянма'
}

const EN_OVERRIDES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  KR: 'South Korea',
  KP: 'North Korea',
  RU: 'Russia',
  HK: 'Hong Kong',
  MO: 'Macao',
  TW: 'Taiwan',
  CZ: 'Czechia',
  TR: 'Türkiye',
  VN: 'Vietnam'
}

/** Распространённые псевдонимы. Ключи нормализуются тем же образом, что и имена файлов. */
const ALIASES: Record<string, string[]> = {
  GB: ['uk', 'u k', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland', 'london'],
  US: ['usa', 'u s a', 'u s', 'america', 'united states of america', 'united states', 'the united states'],
  AE: ['uae', 'u a e', 'emirates', 'united arab emirates', 'dubai'],
  NL: ['holland', 'nederland', 'the netherlands'],
  CZ: ['czech republic', 'czechia', 'czech'],
  KR: ['korea', 'south korea', 'republic of korea', 'korea south'],
  KP: ['north korea', 'dprk'],
  RU: ['russia', 'russian federation', 'rossiya'],
  TR: ['turkiye', 'turkey'],
  VN: ['vietnam', 'viet nam'],
  HK: ['hongkong', 'hong kong', 'hk'],
  MO: ['macau', 'macao'],
  TW: ['taiwan', 'republic of china'],
  LA: ['laos'],
  CI: ['ivory coast', 'cote d ivoire'],
  MM: ['burma', 'myanmar'],
  SZ: ['swaziland', 'eswatini'],
  MK: ['macedonia', 'north macedonia'],
  MD: ['moldova'],
  PS: ['palestine'],
  IR: ['iran'],
  SY: ['syria'],
  BO: ['bolivia'],
  VE: ['venezuela'],
  TZ: ['tanzania'],
  BN: ['brunei'],
  CV: ['cape verde', 'cabo verde'],
  TL: ['east timor', 'timor leste'],
  VA: ['vatican', 'vatican city', 'holy see'],
  DE: ['deutschland'],
  ES: ['espana'],
  IT: ['italia'],
  SE: ['sverige'],
  NO: ['norge'],
  FI: ['suomi'],
  DK: ['danmark'],
  PL: ['polska'],
  CH: ['schweiz', 'suisse', 'svizzera'],
  AT: ['osterreich'],
  BR: ['brasil'],
  MX: ['mexico'],
  JP: ['nippon'],
  UA: ['ukraina'],
  GR: ['hellas'],
  CN: ['prc', 'peoples republic of china'],
  SG: ['sg']
}

/** Локали, названия стран из которых добавляются как псевдонимы (поддержка Unicode-имён). */
const NATIVE_LOCALES = ['en', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'tr', 'ja', 'zh', 'ko', 'ar', 'he', 'el', 'cs', 'sv', 'no', 'fi', 'da', 'hu', 'ro', 'bg', 'sr', 'hr', 'lt', 'lv', 'et', 'hi', 'th', 'vi', 'id']

export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // диакритика снимается только с латиницы, чтобы не ломать «й» и подобные буквы
    .normalize('NFD')
    .replace(/([a-z])[̀-ͯ]+/g, '$1')
    .normalize('NFC')
}

export function tokenize(input: string): string[] {
  return normalizeText(input).match(/\p{L}+|\p{N}+/gu) ?? []
}

function tokenizeKeepCase(input: string): string[] {
  return input.normalize('NFKC').match(/\p{L}+|\p{N}+/gu) ?? []
}

type EntryKind = 'code' | 'name'
interface IndexEntry {
  code: string
  kind: EntryKind
}

let index: Map<string, IndexEntry> | null = null
let allCodes: string[] | null = null

function addKey(map: Map<string, IndexEntry>, rawKey: string, code: string, kind: EntryKind): void {
  const key = tokenize(rawKey).join(' ')
  if (!key) return
  // Короткие латинские слова («us», «de», «uk») слишком двусмысленны: считаем их кодами.
  if (/^[a-z]{1,3}$/.test(key)) kind = 'code'
  const existing = map.get(key)
  // Коды (alpha-2/3) уступают названиям, а первое добавленное название — последующим.
  if (existing && (existing.kind === 'name' || kind === 'code')) return
  map.set(key, { code, kind })
}

function buildIndex(): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>()
  const alpha2 = Object.keys(countries.getAlpha2Codes())
  allCodes = alpha2.sort()

  // 1) Названия: более специфичные источники добавляются первыми.
  for (const [code, names] of Object.entries(ALIASES)) for (const n of names) addKey(map, n, code, n.length <= 3 ? 'code' : 'name')
  for (const code of alpha2) {
    const ruName = RU_OVERRIDES[code]
    if (ruName) addKey(map, ruName, code, 'name')
    const enName = EN_OVERRIDES[code]
    if (enName) addKey(map, enName, code, 'name')
    for (const lang of ['en', 'ru'] as const) {
      const all = countries.getNames(lang, { select: 'all' })[code]
      const list = Array.isArray(all) ? all : all ? [all] : []
      for (const n of list) addKey(map, n, code, 'name')
    }
  }
  for (const loc of NATIVE_LOCALES) {
    let dn: Intl.DisplayNames | null = null
    try {
      dn = new Intl.DisplayNames([loc], { type: 'region' })
    } catch {
      continue
    }
    for (const code of alpha2) {
      try {
        const n = dn.of(code)
        if (n && n !== code) addKey(map, n, code, 'name')
      } catch {
        /* код без названия в этой локали */
      }
    }
  }
  // 2) Склеенные варианты: «unitedkingdom», «hongkong».
  for (const [key, entry] of [...map.entries()]) {
    if (entry.kind === 'name' && key.includes(' ')) {
      const squished = key.replace(/ /g, '')
      if (!map.has(squished)) map.set(squished, entry)
    }
  }
  // 3) Коды ISO — самые слабые ключи.
  for (const code of alpha2) {
    addKey(map, code, code, 'code')
    const a3 = countries.alpha2ToAlpha3(code)
    if (a3) addKey(map, a3, code, 'code')
  }
  return map
}

function getIndex(): Map<string, IndexEntry> {
  return (index ??= buildIndex())
}

export function getAllCountryCodes(): string[] {
  getIndex()
  return allCodes ?? []
}

export function isValidCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && getAllCountryCodes().includes(code)
}

export function getCountryNames(code: string): CountryNames | null {
  const c = code.toUpperCase()
  if (!isValidCountryCode(c)) return null
  const ruName = RU_OVERRIDES[c] ?? countries.getName(c, 'ru', { select: 'official' }) ?? c
  const enName = EN_OVERRIDES[c] ?? countries.getName(c, 'en', { select: 'official' }) ?? c
  return { code: c, ru: ruName, en: enName }
}

/**
 * Ищет страну в имени файла (без расширения). Возвращает null, если страна не распознана.
 * Допускаются суффиксы вида «-2», «_dc1», «Germany Frankfurt».
 */
export function matchCountry(baseName: string): CountryMatch | null {
  const idx = getIndex()
  const tokens = tokenize(baseName)
  const original = tokenizeKeepCase(baseName)
  if (tokens.length === 0 || tokens.length !== original.length) {
    // Нормализация изменила число токенов (редкие символы) — сравниваем по нормализованным.
    if (tokens.length === 0) return null
  }
  for (let len = tokens.length; len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const span = tokens.slice(start, start + len)
      const hit = idx.get(span.join(' ')) ?? (len > 1 ? idx.get(span.join('')) : undefined)
      if (!hit) continue
      if (hit.kind === 'code' && start !== 0) continue // «us» внутри «eu-us-2» — не страна
      const rest = (original.length === tokens.length ? original : tokens).filter((_, i) => i < start || i >= start + len)
      return { code: hit.code, label: rest.join(' ') }
    }
  }
  // Цифровой суффикс, приклеенный к коду: «fr3» уже разбит токенайзером, дополнительных случаев нет.
  return null
}

export interface ProfileIdentity {
  /** Код страны либо null для пользовательского профиля. */
  code: string | null
  /** Стабильный идентификатор группы: «DE» или «custom:имя». */
  groupId: string
  nameRu: string
  nameEn: string
  /** Уточнение (суффикс имени файла), например «2». */
  label: string
}

export function identifyFromFileName(fileName: string): ProfileIdentity {
  const base = fileName.replace(/\.conf$/i, '')
  const match = matchCountry(base)
  if (match) {
    const names = getCountryNames(match.code)!
    return { code: match.code, groupId: match.code, nameRu: names.ru, nameEn: names.en, label: match.label }
  }
  const pretty = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || base
  return {
    code: null,
    groupId: `custom:${tokenize(base).join('-') || base.toLowerCase()}`,
    nameRu: pretty,
    nameEn: pretty,
    label: ''
  }
}
