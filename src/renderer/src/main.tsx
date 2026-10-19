import { createRoot } from 'react-dom/client'
import { ApiProvider } from './api'
import { App } from './App'
import './styles.css'

async function boot(): Promise<void> {
  const root = document.getElementById('root')!
  let api = window.privata
  if (!api && import.meta.env.DEV) {
    // Только для просмотра интерфейса в обычном браузере при разработке (в сборку не попадает).
    api = (await import('./mock')).createMockApi()
  }
  if (!api) {
    root.textContent = 'Не удалось подключиться к приложению.'
    return
  }
  createRoot(root).render(
    <ApiProvider api={api}>
      <App />
    </ApiProvider>
  )
}
void boot()
