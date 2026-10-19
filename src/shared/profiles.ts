/**
 * Построение библиотеки профилей: файлы конфигураций → страны → серверы.
 * Чистая функция без обращения к файловой системе, чтобы её можно было тестировать.
 */
import { createHash } from 'node:crypto'
import type { ConfigIssue, ConfigSummary, ParseResult } from './awgConfig'
import { identifyFromFileName } from './countries'

export interface ScannedFile {
  /** Имя файла с расширением, как на диске. */
  fileName: string
  /** Результат разбора; для нечитаемых файлов — синтетический результат с ошибкой. */
  parsed: ParseResult
}

export interface Profile {
  /** Стабильный идентификатор (хэш имени файла без учёта регистра). */
  id: string
  fileName: string
  groupId: string
  /** Уточнение из имени файла («2», «Frankfurt»). */
  label: string
  ok: boolean
  issues: ConfigIssue[]
  summary: ConfigSummary | null
  fingerprint: string | null
  /** Если профиль дублирует другой файл той же страны — идентификатор оригинала. */
  duplicateOf: string | null
}

export interface CountryGroup {
  /** «DE» или «custom:…». */
  id: string
  code: string | null
  nameRu: string
  nameEn: string
  custom: boolean
  /** Пригодные к подключению профили (без дубликатов и ошибочных файлов). */
  profiles: Profile[]
}

export interface Library {
  countries: CountryGroup[]
  /** Файлы, которые не удалось использовать (ошибки разбора). */
  invalid: Profile[]
  /** Файлы-дубликаты внутри одной страны. */
  duplicates: Profile[]
  totalFiles: number
}

export function profileIdFor(fileName: string): string {
  return createHash('sha1').update(fileName.normalize('NFC').toLowerCase()).digest('hex').slice(0, 12)
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

export function buildLibrary(files: ScannedFile[]): Library {
  const sorted = [...files].sort((a, b) => collator.compare(a.fileName, b.fileName))
  const groups = new Map<string, CountryGroup>()
  const invalid: Profile[] = []
  const duplicates: Profile[] = []
  const seenInGroup = new Map<string, string>() // groupId + fingerprint → profile id
  const seenGlobal = new Map<string, string>() // fingerprint → fileName

  for (const f of sorted) {
    const identity = identifyFromFileName(f.fileName)
    const profile: Profile = {
      id: profileIdFor(f.fileName),
      fileName: f.fileName,
      groupId: identity.groupId,
      label: identity.label,
      ok: f.parsed.ok,
      issues: [...f.parsed.issues],
      summary: f.parsed.summary,
      fingerprint: f.parsed.fingerprint,
      duplicateOf: null
    }
    if (!profile.ok) {
      invalid.push(profile)
      continue
    }
    const dupKey = `${identity.groupId}\u0000${profile.fingerprint}`
    const original = seenInGroup.get(dupKey)
    if (original) {
      profile.duplicateOf = original
      profile.issues.push({ severity: 'warning', code: 'duplicate', message: 'Файл полностью совпадает с другой конфигурацией этой страны и не используется.' })
      duplicates.push(profile)
      continue
    }
    seenInGroup.set(dupKey, profile.id)
    const sameElsewhere = profile.fingerprint ? seenGlobal.get(profile.fingerprint) : undefined
    if (sameElsewhere) {
      profile.issues.push({ severity: 'warning', code: 'duplicate-other-country', message: `Содержимое совпадает с файлом «${sameElsewhere}» (другая страна).` })
    } else if (profile.fingerprint) {
      seenGlobal.set(profile.fingerprint, f.fileName)
    }
    let group = groups.get(identity.groupId)
    if (!group) {
      group = {
        id: identity.groupId,
        code: identity.code,
        nameRu: identity.nameRu,
        nameEn: identity.nameEn,
        custom: identity.code === null,
        profiles: []
      }
      groups.set(identity.groupId, group)
    }
    group.profiles.push(profile)
  }

  const countries = [...groups.values()].sort((a, b) => collator.compare(a.nameRu, b.nameRu))
  return { countries, invalid, duplicates, totalFiles: files.length }
}

/** Подпись профиля в списке нескольких серверов одной страны. */
export function profileTitle(group: CountryGroup, profile: Profile): string {
  return profile.label ? `${group.nameRu} · ${profile.label}` : group.nameRu
}
