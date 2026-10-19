// Тесты службы (Go): логика протокола и раздельного туннелирования + статическая проверка Windows-кода.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const helperDir = resolve(import.meta.dirname, '..', 'helper')
const localGo = join(homedir(), '.local', 'share', 'go-toolchain', 'go', 'bin')
const env = { ...process.env, PATH: [existsSync(localGo) ? localGo : '', process.env.PATH ?? ''].filter(Boolean).join(delimiter) }

function run(args, extra = {}) {
  const r = spawnSync('go', args, { cwd: helperDir, stdio: 'inherit', env: { ...env, ...extra } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run(['test', '-count=1', './...'])
run(['vet', './...'], { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' })
console.log('Go: тесты и go vet (GOOS=windows) пройдены')
