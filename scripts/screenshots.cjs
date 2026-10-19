// Снимки интерфейса для README: скрытое окно Electron открывает режим предпросмотра (макет данных,
// `npm run ui:preview`) и сохраняет PNG. Данные на снимках — иллюстрация, не реальные серверы.
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const out = join(__dirname, '..', 'docs', 'screenshots')
mkdirSync(out, { recursive: true })
const shots = [
  ['home-connected', '?state=connected', null],
  ['home-disconnected', '?state=idle', null],
  ['home-error', '?state=failed', null],
  ['home-empty', '?state=empty', null],
  ['settings-connection', '?state=connected', "document.querySelectorAll('.nav button')[1].click()"],
  ['settings-split', '?state=connected', "document.querySelectorAll('.nav button')[1].click(); setTimeout(()=>document.querySelectorAll('.snav button')[1].click(),150)"],
  ['settings-network', '?state=connected', "document.querySelectorAll('.nav button')[1].click(); setTimeout(()=>document.querySelectorAll('.snav button')[2].click(),150)"],
  ['settings-diagnostics', '?state=connected', "document.querySelectorAll('.nav button')[1].click(); setTimeout(()=>document.querySelectorAll('.snav button')[4].click(),150)"]
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  for (const [name, query, action] of shots) {
    const w = new BrowserWindow({ width: 1110, height: 750, show: false, useContentSize: true, webPreferences: { offscreen: true } })
    for (let i = 0; i < 5; i++) {
      try {
        await w.loadURL('http://127.0.0.1:5199/' + query)
        break
      } catch {
        await sleep(1000)
      }
    }
    await sleep(1500)
    if (action) {
      await w.webContents.executeJavaScript(action)
      await sleep(1200)
    }
    const img = await w.webContents.capturePage()
    writeFileSync(join(out, name + '.png'), img.toPNG())
    console.log('saved', name)
    w.destroy()
  }
  app.quit()
})
