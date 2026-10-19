import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type { AppEntry } from '../shared/ipc'
import { exePathKey, normalizeExePath } from '../shared/split'

/** Постоянная команда без подстановок: список процессов с путями образов. */
const PS_PROCESSES =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'

interface ProcRow {
  ProcessId?: number
  Name?: string
  ExecutablePath?: string
}

/** Группировка процессов по полному пути образа (несколько процессов одного приложения → одна запись). */
export function groupProcesses(rows: ProcRow[]): AppEntry[] {
  const map = new Map<string, AppEntry>()
  for (const r of rows) {
    if (!r.ExecutablePath) continue
    const path = normalizeExePath(r.ExecutablePath)
    if (!path) continue
    const key = exePathKey(path)
    const cur = map.get(key)
    if (cur) cur.processes = (cur.processes ?? 1) + 1
    else map.set(key, { exePath: path, name: r.Name ?? basename(path), source: 'running', processes: 1 })
  }
  return [...map.values()]
}

function listRunningLinux(): AppEntry[] {
  const rows: ProcRow[] = []
  try {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        rows.push({ ProcessId: Number(d), ExecutablePath: readlinkSync(`/proc/${d}/exe`).replace(/ \(deleted\)$/, '') })
      } catch {
        /* нет доступа или поток ядра */
      }
    }
  } catch {
    /* ignore */
  }
  return groupProcesses(rows.map((r) => ({ ...r, Name: basename(r.ExecutablePath ?? '') })))
}

function listRunning(): Promise<AppEntry[]> {
  if (process.platform === 'linux') return Promise.resolve(listRunningLinux())
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PROCESSES],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve([])
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]') as ProcRow | ProcRow[]
          resolve(groupProcesses(Array.isArray(parsed) ? parsed : [parsed]))
        } catch {
          resolve([])
        }
      }
    )
  })
}

function findShortcuts(dir: string, depth: number, out: string[]): void {
  if (depth < 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) findShortcuts(full, depth - 1, out)
    else if (extname(e.name).toLowerCase() === '.lnk') out.push(full)
  }
}

/** Установленные приложения: ярлыки из меню «Пуск» (общие и пользовательские), цели .exe. */
function listInstalled(): AppEntry[] {
  if (process.platform !== 'win32') return []
  const roots = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ]
  const links: string[] = []
  for (const r of roots) findShortcuts(r, 4, links)
  const map = new Map<string, AppEntry>()
  for (const l of links) {
    try {
      const target = shell.readShortcutLink(l).target
      const path = target ? normalizeExePath(target) : null
      if (!path || !existsSync(path)) continue
      const key = exePathKey(path)
      if (!map.has(key)) map.set(key, { exePath: path, name: basename(l, '.lnk'), source: 'installed' })
    } catch {
      /* битый ярлык */
    }
  }
  return [...map.values()]
}

export async function listApps(): Promise<AppEntry[]> {
  const [running] = await Promise.all([listRunning()])
  const installed = listInstalled()
  const merged = new Map<string, AppEntry>()
  for (const a of installed) merged.set(exePathKey(a.exePath), a)
  for (const a of running) {
    const key = exePathKey(a.exePath)
    const inst = merged.get(key)
    merged.set(key, inst ? { ...inst, processes: a.processes, source: 'running' } : a)
  }
  const collator = new Intl.Collator('ru', { sensitivity: 'base' })
  return [...merged.values()].sort((a, b) => collator.compare(a.name, b.name))
}

export async function pickExecutable(win: BrowserWindow | null): Promise<AppEntry | null> {
  const opts = {
    title: 'Выберите приложение',
    properties: ['openFile' as const],
    filters: [{ name: 'Приложения', extensions: ['exe'] }]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const first = r.filePaths[0]
  if (r.canceled || !first) return null
  const path = normalizeExePath(first)
  if (!path) return null
  return { exePath: path, name: basename(path), source: 'installed' }
}

const iconCache = new Map<string, string | null>()

export async function getIcon(exePath: string): Promise<string | null> {
  const path = normalizeExePath(exePath)
  if (!path) return null
  const key = exePathKey(path)
  if (iconCache.has(key)) return iconCache.get(key) ?? null
  try {
    const img = await app.getFileIcon(path, { size: 'normal' })
    const url = img.isEmpty() ? null : img.toDataURL()
    iconCache.set(key, url)
    return url
  } catch {
    iconCache.set(key, null)
    return null
  }
}
