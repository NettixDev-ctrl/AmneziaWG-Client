import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings'

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.path, 'utf8')) as unknown
      this.current = sanitizeSettings(raw)
    } catch {
      this.current = DEFAULT_SETTINGS
    }
    return this.current
  }

  get(): Settings {
    return this.current
  }

  /** Запись через временный файл: при сбое питания файл настроек не остаётся обрезанным. */
  async set(next: Settings): Promise<void> {
    this.current = next
    const data = JSON.stringify(next, null, 2)
    this.saving = this.saving
      .then(async () => {
        await fs.mkdir(dirname(this.path), { recursive: true })
        const tmp = this.path + '.tmp'
        await fs.writeFile(tmp, data, { mode: 0o600 })
        await fs.rename(tmp, this.path)
      })
      .catch(() => undefined)
    await this.saving
  }
}
