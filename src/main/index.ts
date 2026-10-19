import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, shell, Tray,
  type IpcMainInvokeEvent
} from 'electron'
import { redactSecrets } from '../shared/awgConfig'
import { IPC, type DiagnosticsInfo, type Result } from '../shared/ipc'
import { resolveConfigDir, watchConfigDir } from './scanner'
import type { Settings } from '../shared/settings'
import { getIcon, listApps, pickExecutable } from './apps'
import { Controller } from './controller'
import { Logger } from './logger'
import { SettingsStore } from './settingsStore'

const APP_NAME = 'AmneziaWG Client'
// Имя процесса в диспетчере задач/ps и название приложения в системе (вместо «electron»).
process.title = APP_NAME
app.setName(APP_NAME)
// Linux/Wayland: рамку рисует композитор (KWin и др.) по протоколу xdg-decoration, своя полоса не нужна.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

const isWin = process.platform === 'win32'
const log = new Logger()
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let controller: Controller
let store: SettingsStore
let folderWatch: { close: () => void } | null = null

// ---------- пути ----------

/** Каталог с исполняемым файлом; для portable-сборки — каталог самого portable .exe. */
function exeDir(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  return portable && portable.length > 0 ? portable : dirname(app.getPath('exe'))
}

function devRoot(): string | null {
  return app.isPackaged ? null : app.getAppPath()
}

function currentConfigDir(): string {
  return resolveConfigDir({ configured: store.get().app.configDir, exeDir: exeDir(), devRoot: devRoot(), home: homedir(), env: process.env.PRIVATA_CONFIGS_DIR })
}

function resourcePath(...p: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), 'resources', ...p)
}

function helperDirPath(): string {
  const sub = process.platform === 'linux' ? join('helper', 'bin', 'linux') : join('helper', 'bin')
  return app.isPackaged ? join(process.resourcesPath, 'helper') : join(app.getAppPath(), sub)
}

// ---------- окно ----------

const TITLEBAR = {
  dark: { color: '#ffffff', symbolColor: '#1b1b1b' },
  light: { color: '#f3f3f3', symbolColor: '#1b1b1b' }
}

function effectiveTheme(s: Settings): 'dark' | 'light' {
  return s.app.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : s.app.theme
}

function createWindow(showImmediately: boolean): BrowserWindow {
  const theme = effectiveTheme(store.get())
  const w = new BrowserWindow({
    width: 1110,
    height: 782,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: 'AmneziaWG Client',
    icon: resourcePath('icons', 'icon.png'),
    backgroundColor: theme === 'dark' ? '#0b0b0c' : '#f4f4f6',
    autoHideMenuBar: true,
    // Windows: своя полоса с кнопками поверх клиента; Linux — обычная системная рамка
    ...(isWin ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...TITLEBAR[theme], height: 32 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  w.removeMenu()
  const reveal = (): void => {
    if (showImmediately && !w.isDestroyed() && !w.isVisible()) w.show()
  }
  w.once('ready-to-show', reveal)
  w.webContents.once('did-finish-load', reveal)
  // Запасной показ: на некоторых композиторах ready-to-show не приходит (X11 без GPU).
  setTimeout(reveal, 2500)
  w.webContents.on('render-process-gone', (_e, d) => log.error(`render-process-gone: ${d.reason}`))
  w.webContents.on('did-fail-load', (_e, code, desc) => log.error(`did-fail-load: ${code} ${desc}`))
  w.on('close', (e) => {
    if (!quitting && store.get().app.closeToTray && tray) {
      e.preventDefault()
      w.hide()
    }
  })
  w.on('minimize', () => {
    if (store.get().app.minimizeToTray && tray) w.hide()
  })
  // Никакой навигации и всплывающих окон: интерфейс — единственная локальная страница.
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  return w
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow(true)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------- трей ----------

function trayIcon(connected: boolean): Electron.NativeImage {
  const name = connected ? 'tray-on' : 'tray-idle'
  const img = nativeImage.createFromPath(resourcePath('icons', `${name}.png`))
  const hi = nativeImage.createFromPath(resourcePath('icons', `${name}@2x.png`))
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
  return img
}

function updateTray(): void {
  if (!tray) return
  const snap = controller.snapshot()
  const phase = snap.tunnel.phase
  const connected = phase === 'connected'
  const label =
    phase === 'connected' ? `Подключено${snap.active.countryName ? ` — ${snap.active.countryName}` : ''}` :
    phase === 'degraded' ? 'Нет ответа от сервера…' :
    phase === 'starting' || phase === 'handshaking' ? 'Подключение…' :
    phase === 'stopping' ? 'Отключение…' :
    phase === 'failed' ? 'Ошибка подключения' : 'Отключено'
  tray.setImage(trayIcon(connected))
  tray.setToolTip(`AmneziaWG Client — ${label}`)
  const busy = phase === 'starting' || phase === 'handshaking' || phase === 'stopping'
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: label, enabled: false },
      { type: 'separator' },
      { label: 'Открыть AmneziaWG Client', click: showWindow },
      {
        label: phase === 'idle' || phase === 'failed' ? 'Подключить' : 'Отключить',
        enabled: !busy && snap.helper.state !== 'unsupported',
        click: () => void controller.toggle()
      },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  tray = new Tray(trayIcon(false))
  tray.on('click', showWindow)
}

// ---------- IPC ----------

function trustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  if (!win || e.sender !== win.webContents) return false
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) return url.startsWith(process.env.ELECTRON_RENDERER_URL)
  return url.startsWith('file://')
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trustedSender(e)) throw new Error('Запрос от недоверенного источника отклонён.')
    try {
      return await fn(...(args as A))
    } catch (err) {
      log.error(`IPC ${channel}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'Внутренняя ошибка приложения.' }
    }
  })
}

const ok = (): Result => ({ ok: true })
const str = (v: unknown, max = 256): string => (typeof v === 'string' && v.length <= max ? v : '')

function registerIpc(): void {
  handle(IPC.snapshot, () => controller.snapshot())
  handle(IPC.connect, (id: unknown) => controller.connect(str(id, 128) || 'auto'))
  handle(IPC.disconnect, () => controller.disconnect())
  handle(IPC.toggle, () => controller.toggle())
  handle(IPC.selectCountry, (id: unknown) => controller.selectCountry(str(id, 128) || 'auto'))
  handle(IPC.refreshConfigs, async () => {
    await controller.rescan()
    return ok()
  })
  handle(IPC.measureLatency, () => {
    void controller.measureLatency()
    return ok()
  })
  handle(IPC.setSettings, async (patch: unknown) => {
    const prev = store.get()
    const r = await controller.setSettings(patch as never)
    applyOsIntegration(prev, store.get())
    return r
  })
  handle(IPC.openConfigFolder, async () => {
    const dir = currentConfigDir()
    if (!existsSync(dir)) {
      try {
        const { mkdirSync } = await import('node:fs')
        mkdirSync(dir, { recursive: true })
      } catch {
        return { ok: false, error: 'Не удалось создать папку конфигураций.' } as Result
      }
    }
    const err = await shell.openPath(dir)
    return err ? ({ ok: false, error: 'Не удалось открыть папку.' } as Result) : ok()
  })
  handle(IPC.chooseConfigFolder, async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Папка конфигураций', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return ok()
    const prev = store.get()
    const res = await controller.setSettings({ app: { configDir: r.filePaths[0] } } as never)
    applyOsIntegration(prev, store.get())
    return res
  })
  handle(IPC.pickExecutable, async () => ({ ok: true, value: await pickExecutable(win) }))
  handle(IPC.listApps, async () => ({ ok: true, value: await listApps() }))
  handle(IPC.getIcon, (p: unknown) => getIcon(str(p, 1100)))
  handle(IPC.installHelper, () => installHelper())
  handle(IPC.recoverNetwork, () => controller.recoverNetwork())
  handle(IPC.getDiagnostics, async () => ({ ok: true, value: await diagnostics() }))
  handle(IPC.exportDiagnostics, async () => {
    const d = await diagnostics()
    const r = await dialog.showSaveDialog(win!, {
      title: 'Экспорт диагностики',
      defaultPath: join(app.getPath('documents'), `privata-vpn-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`),
      filters: [{ name: 'Текст', extensions: ['txt'] }]
    })
    if (r.canceled || !r.filePath) return { ok: true, value: null }
    writeFileSync(r.filePath, renderDiagnostics(d), { mode: 0o600 })
    return { ok: true, value: r.filePath }
  })
  handle(IPC.openExternal, async (t: unknown) => {
    if (t === 'help') await shell.openExternal('https://github.com/amnezia-vpn/amneziawg-windows-client#readme')
    return ok()
  })
  handle(IPC.setTitleBarTheme, (t: unknown) => {
    if ((t === 'dark' || t === 'light') && win && !win.isDestroyed() && isWin) win.setTitleBarOverlay({ ...TITLEBAR[t], height: 32 })
  })
}

async function diagnostics(): Promise<DiagnosticsInfo> {
  const snap = controller.snapshot()
  const helperLogs = await controller.logs(300)
  return {
    appVersion: app.getVersion(),
    helperVersion: controller.helperVersion(),
    tunnel: snap.tunnel,
    split: snap.split,
    logs: [...log.tail(300), ...helperLogs].map(redactSecrets),
    libraryFiles: snap.library.totalFiles
  }
}

function renderDiagnostics(d: DiagnosticsInfo): string {
  const t = d.tunnel
  return [
    'AmneziaWG Client — диагностика (секреты и адреса скрыты)',
    `Версия приложения: ${d.appVersion}`,
    `Версия службы: ${d.helperVersion ?? 'недоступна'}`,
    `ОС: ${process.platform} ${process.getSystemVersion()}`,
    `Состояние туннеля: ${t.phase}${t.errorCode ? ` (${t.errorCode}: ${t.error ?? ''})` : ''}`,
    `Рукопожатие: ${t.handshakeAgeSec === null ? 'нет' : `${Math.round(t.handshakeAgeSec)} с назад`}`,
    `Раздельное туннелирование: ${d.split.state}${d.split.error ? ` — ${d.split.error}` : ''}, потоков ${d.split.activeFlows}`,
    `Файлов конфигураций: ${d.libraryFiles}`,
    '',
    '--- Журнал ---',
    ...d.logs
  ].join('\n')
}

/** Установка службы: запуск helper.exe install с повышением прав (UAC). Команда постоянная, путь передаётся через окружение. */
async function installHelper(): Promise<Result> {
  if (process.platform === 'linux') {
    const helper = join(helperDirPath(), 'awg-helper')
    if (!existsSync(helper)) return { ok: false, error: 'Файл службы не найден в составе приложения.' }
    // Служба запускается по требованию от root через polkit (pkexec) и работает, пока открыто приложение.
    const child = spawn('pkexec', [helper, 'serve'], { detached: true, stdio: 'ignore' })
    child.unref()
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      await controller.probeHelper()
      if (controller.snapshot().helper.state === 'ok') return ok()
    }
    return { ok: false, error: 'Служба не запустилась (авторизация отклонена или нет pkexec).' }
  }
  if (!isWin) return { ok: false, error: 'Служба недоступна на этой платформе.' }
  const exe = join(helperDirPath(), 'awg-helper.exe')
  if (!existsSync(exe)) return { ok: false, error: 'Файл службы не найден в составе приложения.' }
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:PRIVATA_HELPER -ArgumentList "install" -Verb RunAs -Wait'],
      { env: { ...process.env, PRIVATA_HELPER: exe }, windowsHide: true, timeout: 120_000 },
      () => resolve()
    )
  })
  await controller.probeHelper()
  const snap = controller.snapshot()
  return snap.helper.state === 'ok' ? ok() : { ok: false, error: 'Служба не установлена (запрос прав администратора отклонён или установка не удалась).' }
}

// ---------- интеграция с ОС ----------

function applyOsIntegration(prev: Settings | null, next: Settings): void {
  if (!prev || prev.app.startWithWindows !== next.app.startWithWindows || prev.startBehavior !== next.startBehavior) {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.app.startWithWindows, args: next.startBehavior === 'minimized' ? ['--hidden'] : [] })
    }
  }
  nativeTheme.themeSource = next.app.theme
  if (win && !win.isDestroyed() && isWin) win.setTitleBarOverlay({ ...TITLEBAR[effectiveTheme(next)], height: 32 })
  setupFolderWatch()
}

function setupFolderWatch(): void {
  folderWatch?.close()
  folderWatch = null
  if (store.get().app.watchConfigDir) folderWatch = watchConfigDir(currentConfigDir(), () => void controller.rescan())
}

function notify(title: string, body: string): void {
  if (!store.get().app.notifications || !Notification.isSupported()) return
  new Notification({ title, body, silent: true, icon: resourcePath('icons', 'icon.png') }).show()
}

// ---------- запуск ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.amneziawg.client')
    log.setFile(join(app.getPath('userData'), 'logs', 'app.log'))
    store = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
    const settings = await store.load()
    nativeTheme.themeSource = settings.app.theme

    // Запрещаем все запросы разрешений (камера, геолокация и т.п.): приложению они не нужны.
    const { session } = await import('electron')
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            app.isPackaged
              ? "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
              : "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: ws: http://localhost:*"
          ]
        }
      })
    })

    controller = new Controller({
      log,
      getSettings: () => store.get(),
      saveSettings: (s) => store.set(s),
      getConfigDir: currentConfigDir,
      notify,
      appVersion: app.getVersion()
    })
    controller.on('snapshot', (snap) => {
      win?.webContents.send(IPC.snapshotEvent, snap)
      updateTray()
    })
    registerIpc()

    const startHidden = process.argv.includes('--hidden') && settings.startBehavior === 'minimized'
    createTray()
    win = createWindow(!startHidden)
    applyOsIntegration(null, settings)
    // Папка конфигураций создаётся сразу, чтобы в неё можно было положить .conf файлы
    try {
      mkdirSync(currentConfigDir(), { recursive: true })
    } catch {
      /* нет прав — покажем в интерфейсе */
    }
    await controller.init()
    updateTray()

    if (settings.autoConnect && controller.snapshot().library.countries.length > 0) {
      void controller.toggle()
    }

    powerMonitor.on('resume', () => controller.onResume())
    let online = net.isOnline()
    setInterval(() => {
      const now = net.isOnline()
      if (now && !online) controller.onNetworkRestored()
      online = now
    }, 5000).unref()
  })

  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    folderWatch?.close()
    // Туннель отключается и очищается до выхода, чтобы не оставлять адаптер и правила брандмауэра.
    void controller.shutdown().finally(() => {
      tray?.destroy()
      app.exit(0)
    })
  })

  app.on('window-all-closed', () => {
    /* приложение живёт в трее */
  })
}
