import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, PrivataApi } from '../../shared/ipc'

declare global {
  interface Window {
    privata?: PrivataApi
  }
}

const ApiContext = createContext<PrivataApi | null>(null)

export function ApiProvider({ api, children }: { api: PrivataApi; children: ReactNode }): ReactNode {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): PrivataApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('API недоступен')
  return api
}

/** Подписка на снимок состояния приложения (единственный источник правды — процесс main). */
export function useSnapshot(): AppSnapshot | null {
  const api = useApi()
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void api.getSnapshot().then((s) => alive && setSnap(s))
    const off = api.onSnapshot((s) => alive && setSnap(s))
    return () => {
      alive = false
      off()
    }
  }, [api])
  return snap
}
