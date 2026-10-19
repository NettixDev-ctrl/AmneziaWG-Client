// Сборка привилегированной службы awg-helper.exe (Go, GOOS=windows) и запуск её тестов.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const helperDir = resolve(import.meta.dirname, '..', 'helper')
const localGo = join(homedir(), '.local', 'share', 'go-toolchain', 'go', 'bin')
const env = { ...process.env, PATH: [existsSync(localGo) ? localGo : '', process.env.PATH ?? ''].filter(Boolean).join(delimiter) }

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, { cwd: helperDir, stdio: 'inherit', env: { ...env, ...extraEnv } })
  if (r.status !== 0) {
    console.error(`Команда не выполнена: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

const probe = spawnSync('go', ['version'], { env })
if (probe.status !== 0) {
  console.error('Go не найден. Установите Go 1.25+ (https://go.dev/dl/) и повторите.')
  process.exit(1)
}
mkdirSync(join(helperDir, 'bin'), { recursive: true })
run('go', ['test', './...'])
run('go', ['build', '-trimpath', '-ldflags', '-s -w -X main.version=0.1.0', '-o', join('bin', 'awg-helper.exe'), '.'], {
  GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0'
})
console.log('Готово: helper/bin/awg-helper.exe')
