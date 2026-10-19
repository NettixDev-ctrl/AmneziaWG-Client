import { useEffect, useState, type ReactNode } from 'react'
import { useApi, useSnapshot } from './api'
import { Home } from './Home'
import { IconGear, IconHeadset, IconHome } from './icons'
import { SettingsPage } from './Settings'
import { Toast, useToast } from './ui'
import logo from '../../../resources/icons/logo.png'

type Page = 'home' | 'settings'

function useTheme(theme: 'dark' | 'light' | 'system' | undefined): 'dark' | 'light' {
  const [sys, setSys] = useState<'dark' | 'light'>(() => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const f = (e: MediaQueryListEvent): void => setSys(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return theme === 'light' ? 'light' : theme === 'system' ? sys : 'dark'
}

export function App(): ReactNode {
  const api = useApi()
  const snap = useSnapshot()
  const [page, setPage] = useState<Page>('home')
  const toast = useToast()
  const theme = useTheme(snap?.settings.app.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    void api.setTitleBarTheme(theme)
  }, [theme, api])

  if (!snap) return <div className="app" />

  const lib = snap.library
  const configsText = lib.countries.length === 0 ? 'Конфигурации не найдены' : `Серверов: ${lib.countries.reduce((n, c) => n + c.profiles.length, 0)} · стран: ${lib.countries.length}`
  const helperWarn = snap.helper.state === 'missing' || snap.helper.state === 'error'
  const statusText = helperWarn ? 'Служба не запущена' : configsText

  return (
    <div className="app">
      {snap.platform === 'win32' && (
        <div className="titlebar"><img src={logo} alt="" /><span>AmneziaWG Client</span></div>
      )}
      <main className="page">
        <header className="top">
          <div className="brand">
            <div className="brand__row">
              <img src={logo} alt="" />
              <span className="brand__name">AmneziaWG Client</span>
            </div>
            <div className={`brand__status${helperWarn ? ' warn' : ''}`}>{statusText}</div>
            <button className="brand__link" onClick={() => void api.openConfigFolder()}>Папка конфигураций</button>
          </div>
          <nav className="nav" aria-label="Разделы">
            <button className={page === 'home' ? 'active' : ''} aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}><IconHome />Главная</button>
            <button className={page === 'settings' ? 'active' : ''} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><IconGear />Настройки</button>
          </nav>
          <button className="help" title="Диагностика" aria-label="Диагностика" onClick={() => setPage('settings')}><IconHeadset /></button>
        </header>
        {page === 'home' ? <Home snap={snap} notify={toast.show} /> : <SettingsPage snap={snap} notify={toast.show} />}
      </main>
      <Toast message={toast.message} error={toast.error} />
    </div>
  )
}
