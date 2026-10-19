// Загрузка нативных зависимостей с проверкой SHA-256 (значения зафиксированы здесь).
//   wintun.dll   — драйвер виртуального адаптера (WireGuard LLC, подписан), https://www.wintun.net/
//   WinDivert    — драйвер перехвата пакетов для раздельного туннелирования, https://reqrypt.org/windivert.html
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'resources', 'native')

const ARTIFACTS = [
  {
    name: 'wintun-0.14.1',
    url: 'https://www.wintun.net/builds/wintun-0.14.1.zip',
    sha256: '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51',
    files: { 'wintun/bin/amd64/wintun.dll': 'wintun.dll', 'wintun/LICENSE.txt': 'LICENSE-wintun.txt' }
  },
  {
    name: 'WinDivert-2.2.2-A',
    url: 'https://github.com/basil00/WinDivert/releases/download/v2.2.2/WinDivert-2.2.2-A.zip',
    sha256: '63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15',
    files: {
      'WinDivert-2.2.2-A/x64/WinDivert.dll': 'WinDivert.dll',
      'WinDivert-2.2.2-A/x64/WinDivert64.sys': 'WinDivert64.sys',
      'WinDivert-2.2.2-A/LICENSE': 'LICENSE-WinDivert.txt'
    }
  }
]

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function extract(zip, dir) {
  for (const [cmd, args] of [['tar', ['-xf', zip, '-C', dir]], ['unzip', ['-q', '-o', zip, '-d', dir]]]) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' })
    if (r.status === 0) return
  }
  throw new Error('Не удалось распаковать архив: нужен tar (bsdtar) или unzip.')
}

mkdirSync(out, { recursive: true })
for (const a of ARTIFACTS) {
  const done = Object.values(a.files).every((f) => existsSync(join(out, f)))
  if (done) {
    console.log(`✓ ${a.name}: уже на месте`)
    continue
  }
  console.log(`↓ ${a.name}`)
  const res = await fetch(a.url)
  if (!res.ok) throw new Error(`${a.url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== a.sha256) throw new Error(`${a.name}: контрольная сумма не совпала (ожидалось ${a.sha256}, получено ${got})`)
  const tmp = mkdtempSync(join(tmpdir(), 'privata-native-'))
  try {
    const zip = join(tmp, 'a.zip')
    writeFileSync(zip, buf)
    extract(zip, tmp)
    for (const [src, dst] of Object.entries(a.files)) copyFileSync(join(tmp, src), join(out, dst))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`✓ ${a.name}: проверено и распаковано`)
}
// Сводка для отчёта о сборке
const manifest = ARTIFACTS.map((a) => `${a.name} sha256=${a.sha256}`).join('\n') + '\n'
writeFileSync(join(out, 'NATIVE-MANIFEST.txt'), manifest)
