import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSecrets } from '../shared/awgConfig'

/** Журнал приложения: кольцевой буфер в памяти + файл. Любая строка проходит маскирование секретов. */
export class Logger {
  private lines: string[] = []
  private path: string | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly max = 1000) {}

  setFile(path: string): void {
    this.path = path
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `${new Date().toISOString()} [${level}] ${redactSecrets(message)}`
    this.lines.push(line)
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max)
    if (this.path) {
      const path = this.path
      this.writing = this.writing
        .then(async () => {
          await mkdir(dirname(path), { recursive: true })
          const st = await stat(path).catch(() => null)
          if (st && st.size > 1_000_000) await rename(path, path + '.old').catch(() => undefined)
          await appendFile(path, line + '\n', { mode: 0o600 })
        })
        .catch(() => undefined)
    }
  }

  info(m: string): void { this.log('info', m) }
  warn(m: string): void { this.log('warn', m) }
  error(m: string): void { this.log('error', m) }

  tail(n = 300): string[] {
    return this.lines.slice(-n)
  }
}
