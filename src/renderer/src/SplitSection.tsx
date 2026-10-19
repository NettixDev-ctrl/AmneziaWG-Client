import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppEntry, AppSnapshot } from '../../shared/ipc'
import { countRu } from '../../shared/ru'
import { exePathKey, validateSplitRule, type SplitMode, type SplitRule } from '../../shared/split'
import { useApi } from './api'
import { IconPlus, IconSearch, IconTrash } from './icons'
import { Toggle, useScrollingClass } from './ui'

const MODES: Array<{ id: SplitMode; title: string; desc: string }> = [
  { id: 'all', title: 'Весь трафик через VPN', desc: 'Все приложения используют туннель. Правила ниже не действуют.' },
  { id: 'include', title: 'Только выбранные приложения через VPN', desc: 'Через туннель идёт трафик только выбранных приложений, всё остальное — напрямую.' },
  { id: 'bypass', title: 'Выбранные приложения в обход VPN', desc: 'Выбранные приложения подключаются напрямую, остальной трафик идёт через туннель.' }
]

function useIcon(path: string): string | null {
  const api = useApi()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.getIcon(path).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [api, path])
  return url
}

function AppIcon({ path }: { path: string }): ReactNode {
  const url = useIcon(path)
  return <span className="rule__ico">{url ? <img src={url} alt="" /> : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>app</span>}</span>
}

export function SplitSection({ snap, notify }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void }): ReactNode {
  const api = useApi()
  const s = snap.settings
  const [picker, setPicker] = useState(false)
  const adaptive = s.connectionMode === 'adaptive'
  const rules = s.split.rules

  const save = async (patch: { mode?: SplitMode; rules?: SplitRule[] }): Promise<void> => {
    const r = await api.setSettings({ split: { mode: patch.mode ?? s.split.mode, rules: patch.rules ?? rules } })
    if (!r.ok) notify(r.error, true)
  }

  const add = async (e: AppEntry): Promise<void> => {
    const { rule, error } = validateSplitRule({ exePath: e.exePath, name: e.name })
    if (!rule) return notify(error ?? 'Недопустимый путь.', true)
    if (rules.some((r) => exePathKey(r.exePath) === exePathKey(rule.exePath))) return notify('Это приложение уже добавлено.', true)
    await save({ rules: [...rules, rule] })
  }

  return (
    <>
      <h2>Раздельное туннелирование</h2>
      <p className="lead">
        Приложения определяются по полному пути к исполняемому файлу; дочерние процессы наследуют правило, поэтому браузеры и другие многопроцессные программы работают целиком.
      </p>

      {!adaptive && s.split.mode !== 'all' && (
        <div className="note note--warn">
          Правила применяются только в типе подключения «Адаптивный». Сейчас выбран «{s.connectionMode === 'auto' ? 'Авто' : 'Быстрый'}», поэтому весь трафик идёт через VPN.{' '}
          <button onClick={() => void api.setSettings({ connectionMode: 'adaptive' })}>Включить «Адаптивный»</button>
        </div>
      )}

      <div className="radio-cards" role="radiogroup" aria-label="Режим раздельного туннелирования">
        {MODES.map((m) => (
          <button key={m.id} className="radio-card" role="radio" aria-checked={s.split.mode === m.id} onClick={() => void save({ mode: m.id })}>
            <span className="rc" />
            <span>
              <div className="srow__label">{m.title}</div>
              <div className="srow__desc">{m.desc}</div>
            </span>
          </button>
        ))}
      </div>

      {snap.split.state !== 'off' && (
        <div className={`note${snap.split.state === 'failed' ? ' note--err' : ''}`}>
          Движок раздельного туннелирования:{' '}
          <b>{snap.split.state === 'running' ? `работает (потоков: ${snap.split.activeFlows})` : snap.split.state === 'starting' ? 'запускается…' : 'не запущен'}</b>
          {snap.split.error && <div style={{ marginTop: 4 }}>{snap.split.error}</div>}
        </div>
      )}

      {s.split.mode !== 'all' && (
        <>
          <div className="srow srow--stack" style={{ borderTop: 0, paddingBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="srow__text">
                <div className="srow__label">Приложения ({rules.length})</div>
                <div className="srow__desc">
                  {s.split.mode === 'include' ? 'Через VPN пойдёт трафик этих приложений.' : 'Эти приложения будут подключаться напрямую.'}
                </div>
              </div>
              <button className="btn btn--primary" onClick={() => setPicker(true)}><IconPlus /> Добавить</button>
            </div>
          </div>
          {rules.length === 0 ? (
            <div className="note">Список пуст. {s.split.mode === 'include' ? 'Без приложений в списке подключение в этом режиме невозможно.' : 'Добавьте приложения, которые должны работать напрямую.'}</div>
          ) : (
            <div className="rules">
              {rules.map((r) => (
                <div className="rule" key={r.id}>
                  <AppIcon path={r.exePath} />
                  <div className="rule__text">
                    <div className="rule__name">{r.name}</div>
                    <div className="rule__path" title={r.exePath}>{r.exePath}</div>
                  </div>
                  <Toggle label={`Правило для ${r.name}`} checked={r.enabled} onChange={(v) => void save({ rules: rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) })} />
                  <button className="icon-btn" title="Удалить правило" aria-label={`Удалить ${r.name}`} onClick={() => void save({ rules: rules.filter((x) => x.id !== r.id) })}><IconTrash /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="note" style={{ marginTop: 16 }}>
        <b>Как это работает и каковы ограничения.</b> Туннель всегда полный (с kill switch). Пакеты приложений «в обход» перехватываются драйвером WinDivert в службе и уходят через физический адаптер; для режима «только выбранные» в обход направляются все остальные процессы. Поддерживается IPv4 (TCP/UDP): ICMP и фрагментированные пакеты идут через туннель; приложения с IPv6-трафиком используют IPv4. Соединения, открытые до включения режима, остаются в туннеле. Если движок не запустился, весь трафик остаётся в VPN — утечки не происходит. Универсальные приложения Microsoft Store и службы в общем svchost.exe по пути не различаются.
      </div>

      {picker && <AppPicker rules={rules} onClose={() => setPicker(false)} onAdd={(e) => void add(e)} />}
    </>
  )
}

function AppPicker({ rules, onClose, onAdd }: { rules: SplitRule[]; onClose: () => void; onAdd: (e: AppEntry) => void }): ReactNode {
  const api = useApi()
  const [apps, setApps] = useState<AppEntry[] | null>(null)
  const [tab, setTab] = useState<'running' | 'installed'>('running')
  const [q, setQ] = useState('')
  const scroll = useScrollingClass()

  useEffect(() => {
    let alive = true
    void api.listApps().then((r) => alive && setApps(r.ok ? r.value : []))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
    }
  }, [api, onClose])

  const taken = useMemo(() => new Set(rules.map((r) => exePathKey(r.exePath))), [rules])
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (apps ?? [])
      .filter((a) => (tab === 'running' ? a.source === 'running' : true))
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.exePath.toLowerCase().includes(needle))
  }, [apps, tab, q])

  const browse = async (): Promise<void> => {
    const r = await api.pickExecutable()
    if (r.ok && r.value) onAdd(r.value)
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Выбор приложения">
        <div className="modal__head">
          <h3>Добавить приложение</h3>
          <button className="btn" onClick={() => void browse()}>Обзор…</button>
          <button className="btn" onClick={onClose}>Готово</button>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <div className="seg">
            <button aria-pressed={tab === 'running'} onClick={() => setTab('running')}>Запущенные</button>
            <button aria-pressed={tab === 'installed'} onClick={() => setTab('installed')}>Все найденные</button>
          </div>
          <label className="search" style={{ flex: 1, margin: 0 }}>
            <IconSearch />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или путь" aria-label="Поиск приложений" />
          </label>
        </div>
        <div className={`list ${scroll.className}`} ref={scroll.ref} onScroll={scroll.onScroll}>
          {apps === null && <div className="empty"><p>Загрузка списка…</p></div>}
          {apps !== null && list.length === 0 && (
            <div className="empty"><p>{apps.length === 0 ? 'Список недоступен на этой платформе. Используйте «Обзор…».' : 'Ничего не найдено.'}</p></div>
          )}
          {list.map((a) => (
            <button key={exePathKey(a.exePath)} className="picker-row" disabled={taken.has(exePathKey(a.exePath))} onClick={() => onAdd(a)}>
              <AppIcon path={a.exePath} />
              <span className="rule__text">
                <div className="rule__name">{a.name}{a.processes ? <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {countRu(a.processes, ['процесс', 'процесса', 'процессов'])}</span> : null}</div>
                <div className="rule__path" title={a.exePath}>{a.exePath}</div>
              </span>
              {taken.has(exePathKey(a.exePath)) ? <span style={{ color: 'var(--text-3)', fontSize: 12 }}>добавлено</span> : <IconPlus style={{ width: 16, height: 16, color: 'var(--text-2)' }} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
