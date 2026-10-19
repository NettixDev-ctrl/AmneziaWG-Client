/**
 * Правила раздельного туннелирования: проверка и нормализация путей исполняемых файлов.
 * Правило идентифицирует приложение по ПОЛНОМУ пути к исполняемому файлу, а не по отображаемому имени.
 */
export type SplitMode = 'all' | 'include' | 'bypass'

export interface SplitRule {
  id: string
  exePath: string
  name: string
  enabled: boolean
}

export interface SplitRuleError {
  index: number
  message: string
}

export const MAX_SPLIT_RULES = 200
const MAX_PATH_LENGTH = 1024
const FORBIDDEN_CHARS = /[<>"|?*\u0000-\u001f%]/

/**
 * Приводит путь к каноническому виду. Возвращает null, если путь недопустим.
 * Допускаются абсолютные пути Windows на диске («C:\…») и UNC («\\сервер\ресурс\…») к .exe,
 * а также абсолютные пути POSIX («/usr/bin/firefox») для Linux.
 */
export function normalizeExePath(input: string): string | null {
  if (typeof input !== 'string') return null
  let p = input.trim()
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim()
  if (!p || p.length > MAX_PATH_LENGTH) return null
  if (p.startsWith('/')) return normalizePosixPath(p)
  p = p.replace(/\//g, '\\')
  // Префиксы устройств («\\.\», «\\?\») не поддерживаются: через них можно обойти сопоставление.
  if (/^\\\\[.?]\\/.test(p)) return null
  const isUnc = p.startsWith('\\\\')
  const isDrive = /^[A-Za-z]:\\/.test(p)
  if (!isUnc && !isDrive) return null
  if (FORBIDDEN_CHARS.test(isDrive ? p.slice(2) : p)) return null
  // Схлопываем повторные разделители, сохраняя UNC-префикс.
  const head = isUnc ? '\\\\' : ''
  const body = (isUnc ? p.slice(2) : p).replace(/\\{2,}/g, '\\')
  const segments = body.split('\\')
  if (segments.some((s) => s === '.' || s === '..' || s.length > 255)) return null
  if (isDrive && segments[0] && !/^[A-Za-z]:$/.test(segments[0])) return null
  if (isUnc && segments.length < 3) return null
  const last = segments[segments.length - 1] ?? ''
  if (!/\.exe$/i.test(last) || last.length <= 4) return null
  return head + body
}

const POSIX_FORBIDDEN = /[\u0000-\u001f\u007f*?"<>|]/

/** Абсолютный путь POSIX: без «.», «..», повторных и завершающих слэшей. */
function normalizePosixPath(p: string): string | null {
  if (POSIX_FORBIDDEN.test(p)) return null
  const segments = p.split('/').filter((s) => s !== '')
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..' || s.length > 255)) return null
  return '/' + segments.join('/')
}

/** Ключ сравнения: пути Windows нечувствительны к регистру, пути POSIX — чувствительны. */
export function exePathKey(path: string): string {
  const n = path.normalize('NFC')
  return n.startsWith('/') ? n : n.toLowerCase()
}

export function exeBaseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
}

export function validateSplitRule(rule: unknown): { rule: SplitRule | null; error: string | null } {
  if (typeof rule !== 'object' || rule === null) return { rule: null, error: 'Некорректное правило.' }
  const r = rule as Record<string, unknown>
  if (typeof r.exePath !== 'string') return { rule: null, error: 'Не указан путь к приложению.' }
  const path = normalizeExePath(r.exePath)
  if (!path) return { rule: null, error: 'Укажите полный путь к приложению (C:\\Program Files\\App\\app.exe или /usr/bin/app) без подстановок и спецсимволов.' }
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : exeBaseName(path)
  const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : ruleIdFor(path)
  return { rule: { id, exePath: path, name, enabled: r.enabled !== false }, error: null }
}

export function ruleIdFor(path: string): string {
  // Детерминированный короткий идентификатор (FNV-1a), чтобы повторное добавление не плодило дубликаты.
  let h = 0x811c9dc5
  const s = exePathKey(path)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Проверяет список правил: отбрасывает недопустимые и повторяющиеся. */
export function validateSplitRules(rules: unknown): { valid: SplitRule[]; errors: SplitRuleError[] } {
  const valid: SplitRule[] = []
  const errors: SplitRuleError[] = []
  if (!Array.isArray(rules)) return { valid, errors: [{ index: -1, message: 'Список правил должен быть массивом.' }] }
  const seen = new Set<string>()
  rules.forEach((raw, index) => {
    if (valid.length >= MAX_SPLIT_RULES) {
      if (errors.every((e) => e.index !== -2)) errors.push({ index: -2, message: `Превышен предел в ${MAX_SPLIT_RULES} правил.` })
      return
    }
    const { rule, error } = validateSplitRule(raw)
    if (!rule) {
      errors.push({ index, message: error ?? 'Недопустимое правило.' })
      return
    }
    const key = exePathKey(rule.exePath)
    if (seen.has(key)) {
      errors.push({ index, message: `Приложение «${rule.name}» уже добавлено.` })
      return
    }
    seen.add(key)
    valid.push(rule)
  })
  return { valid, errors }
}

export function isSplitMode(v: unknown): v is SplitMode {
  return v === 'all' || v === 'include' || v === 'bypass'
}

/** Что отправляется в службу: только включённые правила и режим. Пути — канонические. */
export function splitPayload(mode: SplitMode, rules: SplitRule[]): { mode: SplitMode; apps: string[] } {
  if (mode === 'all') return { mode, apps: [] }
  return { mode, apps: rules.filter((r) => r.enabled).map((r) => r.exePath) }
}
