import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppSnapshot, type PrivataApi } from '../shared/ipc'

/** Узкий мост: renderer получает только перечисленные методы, никаких прямых обращений к Node или файлам. */
const api: PrivataApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  onSnapshot: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, s: AppSnapshot): void => cb(s)
    ipcRenderer.on(IPC.snapshotEvent, handler)
    return () => ipcRenderer.removeListener(IPC.snapshotEvent, handler)
  },
  connect: (id) => ipcRenderer.invoke(IPC.connect, id),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  toggle: () => ipcRenderer.invoke(IPC.toggle),
  selectCountry: (id) => ipcRenderer.invoke(IPC.selectCountry, id),
  refreshConfigs: () => ipcRenderer.invoke(IPC.refreshConfigs),
  measureLatency: () => ipcRenderer.invoke(IPC.measureLatency),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  openConfigFolder: () => ipcRenderer.invoke(IPC.openConfigFolder),
  chooseConfigFolder: () => ipcRenderer.invoke(IPC.chooseConfigFolder),
  pickExecutable: () => ipcRenderer.invoke(IPC.pickExecutable),
  listApps: () => ipcRenderer.invoke(IPC.listApps),
  getIcon: (p) => ipcRenderer.invoke(IPC.getIcon, p),
  installHelper: () => ipcRenderer.invoke(IPC.installHelper),
  recoverNetwork: () => ipcRenderer.invoke(IPC.recoverNetwork),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.exportDiagnostics),
  openExternal: (t) => ipcRenderer.invoke(IPC.openExternal, t),
  setTitleBarTheme: (t) => ipcRenderer.invoke(IPC.setTitleBarTheme, t)
}

contextBridge.exposeInMainWorld('privata', api)
