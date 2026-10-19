import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { MAX_CONFIG_BYTES, parseAwgConfig, type ParseResult } from '../shared/awgConfig'
import { buildLibrary, type Library, type ScannedFile } from '../shared/profiles'

export interface ScanResult {
  dir: string
  exists: boolean
  library: Library
  /** Ошибка чтения самой папки (нет доступа и т.п.). */
  dirError: string | null
}

function failed(message: string, code: string): ParseResult {
  return { ok: false, config: null, summary: null, issues: [{ severity: 'error', code, message }], fingerprint: null }
}

function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

/** Считывает и разбирает один файл; путь обязан лежать внутри папки конфигураций. */
export async function readConfigFile(dir: string, fileName: string): Promise<ParseResult> {
  const root = resolve(dir)
  const full = resolve(root, fileName)
  if (!full.startsWith(root + sep) || fileName.includes('/') || fileName.includes('\\')) {
    return failed('Недопустимое имя файла.', 'bad-path')
  }
  try {
    const st = await fs.lstat(full)
    if (st.isSymbolicLink()) return failed('Символические ссылки не поддерживаются — положите сюда сам файл.', 'symlink')
    if (!st.isFile()) return failed('Это не обычный файл.', 'not-file')
    if (st.size > MAX_CONFIG_BYTES) return failed('Файл конфигурации слишком большой (больше 64 КБ).', 'too-large')
    const real = await fs.realpath(full)
    const realRoot = await fs.realpath(root)
    if (!real.startsWith(realRoot + sep)) return failed('Файл находится вне папки конфигураций.', 'outside')
    const buf = await fs.readFile(full)
    return parseAwgConfig(decode(buf))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return failed(code === 'EACCES' || code === 'EPERM' ? 'Нет доступа к файлу.' : 'Не удалось прочитать файл.', 'read-error')
  }
}

export async function scanConfigDir(dir: string): Promise<ScanResult> {
  const empty = buildLibrary([])
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { dir, exists: false, library: empty, dirError: null }
    return { dir, exists: false, library: empty, dirError: 'Нет доступа к папке конфигураций.' }
  }
  const confs = names.filter((n) => /\.conf$/i.test(n) && n.length > 5)
  const files: ScannedFile[] = []
  // Небольшими пачками, чтобы не открывать сотни файлов одновременно.
  for (let i = 0; i < confs.length; i += 16) {
    const batch = confs.slice(i, i + 16)
    const parsed = await Promise.all(batch.map((n) => readConfigFile(dir, n)))
    batch.forEach((n, k) => files.push({ fileName: n, parsed: parsed[k]! }))
  }
  return { dir, exists: true, library: buildLibrary(files), dirError: null }
}

/** Следит за папкой; вызывает onChange не чаще раза в delay мс. */
export function watchConfigDir(dir: string, onChange: () => void, delay = 400): { close: () => void } {
  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, delay)
  }
  try {
    watcher = fsWatch(dir, { persistent: false }, schedule)
    watcher.on('error', () => undefined)
  } catch {
    /* папки может не быть — повторная попытка при ручном обновлении */
  }
  return {
    close: () => {
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }
}

export interface ConfigDirInputs {
  configured: string | null
  /** Каталог, в котором лежит исполняемый файл (для portable — каталог самого portable .exe). */
  exeDir: string
  /** Для режима разработки: корень проекта. */
  devRoot?: string | null
  /** Домашний каталог пользователя (os.homedir()). */
  home?: string | null
  env?: string | undefined
}

/** Выбор папки: переменная окружения → настройка → «configs» рядом с программой. */
export function resolveConfigDir(i: ConfigDirInputs): string {
  if (i.env && i.env.trim()) return resolve(i.env.trim())
  if (i.configured) return resolve(i.configured)
  // По умолчанию — ~/.awg/configs (как у других клиентов AmneziaWG); папка рядом с программой — запасной вариант.
  if (i.home) return join(i.home, '.awg', 'configs')
  return join(i.devRoot ?? i.exeDir, 'configs')
}
