import { useMemo, useState, type ReactNode } from 'react'
import type { AppSnapshot, CountryView } from '../../shared/ipc'
import { countRu, pluralRu } from '../../shared/ru'
import type { ConnectionMode } from '../../shared/settings'
import { isActivePhase } from '../../shared/tunnelState'
import { useApi, } from './api'
import { Flag } from './Flag'
import { Globe } from './Globe'
import { IconBolt, IconCheck, IconGlobe, IconHelp, IconPuzzle, IconRefresh, IconSearch, IconSparkle, IconWarn, SignalBars } from './icons'
import { describeStage } from './status'
import { useScrollingClass } from './ui'

const MODES: Array<{ id: ConnectionMode; name: string; desc: string; icon: ReactNode }> = [
  { id: 'auto', name: 'Авто', desc: 'Лучший тип подключения будет выбран автоматически', icon: <IconSparkle /> },
  { id: 'fast', name: 'Быстрый', desc: 'Максимальная скорость для повседневного использования', icon: <IconBolt /> },
  { id: 'adaptive', name: 'Адаптивный', desc: 'Для приложений, которые обычно блокируют VPN', icon: <IconPuzzle /> }
]

const MODE_LABEL: Record<ConnectionMode, string> = { auto: 'Авто', fast: 'Быстрый', adaptive: 'Адаптивный' }

function barsFor(c: Pick<CountryView, 'quality' | 'bestRttMs'>): { level: 0 | 1 | 2 | 3; tone: 'good' | 'fair' | 'poor' | 'unknown'; title: string } {
  switch (c.quality) {
    case 'good': return { level: 3, tone: 'good', title: `Задержка до сервера ${c.bestRttMs} мс` }
    case 'fair': return { level: 2, tone: 'fair', title: `Задержка до сервера ${c.bestRttMs} мс` }
    case 'poor': return { level: 1, tone: 'poor', title: `Задержка до сервера ${c.bestRttMs} мс` }
    default: return { level: 0, tone: 'unknown', title: 'Задержка не измерена' }
  }
}

export function Home({ snap, notify }: { snap: AppSnapshot; notify: (m: string, err?: boolean) => void }): ReactNode {
  const api = useApi()
  const stage = describeStage(snap)
  const { settings, library } = snap
  const selected = library.countries.find((c) => c.id === settings.selectedCountryId) ?? null
  const active = snap.active.countryId ? library.countries.find((c) => c.id === snap.active.countryId) ?? null : null
  const shown = active ?? selected
  const globeCode = shown?.code ?? null
  const busy = snap.tunnel.phase === 'stopping'

  const act = async (p: Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    const r = await p
    if (!r.ok && r.error) notify(r.error, true)
  }

  const onStageClick = (): void => {
    if (busy) return
    if (stage.clickConnects) void act(api.toggle())
    else void act(api.disconnect())
  }

  const onPick = (id: string): void => {
    if (isActivePhase(snap.tunnel.phase) || snap.tunnel.phase === 'failed') void act(api.connect(id))
    else void act(api.selectCountry(id))
  }

  return (
    <div className="home">
      <section className="stage" aria-label="Подключение">
        <div className="stage__disc">
          <Globe countryCode={globeCode} tone={stage.tone} />
        </div>
        <button className="stage__hit" onClick={onStageClick} aria-label={`${stage.label}. ${stage.hint}`} />
        <div className={`stage__status ${stage.kind}`}>
          <span className="dot">{stage.kind === 'on' || stage.kind === 'warn' ? <IconCheck /> : stage.kind === 'error' ? <IconWarn style={{ width: 13, height: 13 }} /> : null}</span>
          {stage.label}
        </div>
        {snap.helper.state === 'ok' || snap.helper.state === 'unknown' ? (
          <div className="stage__hint">
            {stage.hint}
            {stage.detail && <small className={stage.kind === 'error' ? 'err' : ''}>{stage.detail}</small>}
          </div>
        ) : (
          <HelperNotice snap={snap} notify={notify} />
        )}
        <ActivePill snap={snap} country={shown} />
      </section>

      <aside className="side">
        <ModesCard snap={snap} onChange={(m) => void act(api.setSettings({ connectionMode: m }))} />
        <CountriesCard snap={snap} onPick={onPick} onConnect={(id) => void act(api.connect(id))} notify={notify} />
      </aside>
    </div>
  )
}

function HelperNotice({ snap, notify }: { snap: AppSnapshot; notify: (m: string, err?: boolean) => void }): ReactNode {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const h = snap.helper
  if (h.state === 'ok' || h.state === 'unknown') return null
  const install = async (): Promise<void> => {
    setBusy(true)
    const r = await api.installHelper()
    setBusy(false)
    if (!r.ok) notify(r.error, true)
    else notify('Служба установлена.')
  }
  return (
    <div className="stage__notice">
      {h.state === 'missing' ? (
        <>
          <span>Для подключения нужна служба AmneziaWG Client с правами администратора (запрос пароля системой).</span>
          <button className="btn btn--primary" disabled={busy} onClick={() => void install()}>
            {busy ? 'Запуск…' : snap.platform === 'linux' ? 'Запустить службу' : 'Установить службу'}
          </button>
        </>
      ) : (
        <span>{h.message}</span>
      )}
    </div>
  )
}

function ActivePill({ snap, country }: { snap: AppSnapshot; country: CountryView | null }): ReactNode {
  const mode = snap.settings.connectionMode
  const modeIcon = mode === 'auto' ? <IconSparkle /> : mode === 'fast' ? <IconBolt /> : <IconPuzzle />
  const name = country ? country.nameRu : 'Авто'
  const bars = country ? barsFor(country) : { level: 0 as const, tone: 'unknown' as const, title: 'Задержка не измерена' }
  return (
    <div className="active-pill" aria-live="polite">
      <div className="active-pill__icons">
        {country ? <Flag code={country.code} size={40} /> : <span className="flag--auto" style={{ width: 40, height: 40, position: 'absolute', left: 0, top: 3 }}><IconGlobe style={{ width: 21, height: 21 }} /></span>}
        <span className={`mode-badge mode-badge--${mode}`}>{modeIcon}</span>
      </div>
      <div className="active-pill__text">
        <span className="active-pill__name">{name}</span>
        <span className="active-pill__mode">{MODE_LABEL[mode]}</span>
      </div>
      <SignalBars level={bars.level} tone={bars.tone} size={22} title={bars.title} />
    </div>
  )
}

function ModesCard({ snap, onChange }: { snap: AppSnapshot; onChange: (m: ConnectionMode) => void }): ReactNode {
  const s = snap.settings
  const rules = s.split.rules.filter((r) => r.enabled).length
  return (
    <section className="card" aria-label="Типы подключения">
      <h2 className="card__title" style={{ margin: 0 }}>
        Типы подключения
        <span className="help-i" title="Режим определяет, как выбирается сервер и применяются правила раздельного туннелирования."><IconHelp /></span>
      </h2>
      <div className="modes" role="radiogroup" aria-label="Тип подключения">
        {MODES.map((m) => (
          <button key={m.id} className="mode" role="radio" aria-checked={s.connectionMode === m.id} onClick={() => onChange(m.id)}>
            <span className={`icon-sq icon-sq--${m.id}`}>{m.icon}</span>
            <span className="mode__body">
              <div className="mode__name">{m.name}</div>
              <div className="mode__desc">{m.desc}</div>
              {m.id === 'adaptive' && s.connectionMode === 'adaptive' && s.split.mode !== 'all' && (
                <div className="mode__extra">
                  {s.split.mode === 'bypass' ? 'Мимо VPN' : 'Только через VPN'}: {countRu(rules, ['приложение', 'приложения', 'приложений'])}
                </div>
              )}
            </span>
            <span className="mode__tick">{s.connectionMode === m.id && <IconCheck />}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function CountriesCard({ snap, onPick, onConnect, notify }: { snap: AppSnapshot; onPick: (id: string) => void; onConnect: (id: string) => void; notify: (m: string, err?: boolean) => void }): ReactNode {
  const api = useApi()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const scroll = useScrollingClass()
  const { library, settings } = snap
  const connectedId = snap.tunnel.phase === 'connected' || snap.tunnel.phase === 'degraded' ? snap.active.countryId : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/ё/g, 'е')
    if (!q) return library.countries
    return library.countries.filter((c) => c.nameRu.toLowerCase().replace(/ё/g, 'е').includes(q) || (c.code ?? '').toLowerCase() === q)
  }, [library.countries, query])

  const refresh = async (): Promise<void> => {
    const r = await api.refreshConfigs()
    if (!r.ok) notify(r.error, true)
    else void api.measureLatency()
  }
  const empty = library.countries.length === 0
  const showAuto = !query.trim() && !empty

  return (
    <section className="card countries" aria-label="Страны">
      <h2 className="card__title" style={{ margin: 0 }}>
        Страны
        <span className="help-i" title="Список строится из файлов .conf в папке конфигураций. Индикатор — измеренная задержка до сервера (ICMP)."><IconHelp /></span>
        <span className="card__tools">
          <button className="icon-btn" title="Поиск" aria-label="Поиск стран" onClick={() => { setSearching((v) => !v); setQuery('') }}><IconSearch /></button>
          <button className={`icon-btn${snap.measuring ? ' spin' : ''}`} title="Обновить конфигурации и задержки" aria-label="Обновить" onClick={() => void refresh()}><IconRefresh /></button>
        </span>
      </h2>
      {searching && (
        <label className="search">
          <IconSearch />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск страны" aria-label="Поиск страны" />
        </label>
      )}
      {empty ? (
        <div className="empty">
          <IconGlobe style={{ width: 34, height: 34, color: 'var(--text-3)' }} />
          <h3>Конфигурации не найдены</h3>
          <p>
            {library.dirError ?? (library.exists
              ? 'В папке нет файлов .conf. Положите сюда конфигурации AmneziaWG — например, Germany.conf или Japan.conf: страна определится по имени файла.'
              : 'Папка конфигураций ещё не создана. Создайте её и добавьте файлы .conf.')}
          </p>
          <code>{library.configDir}</code>
          {library.invalid.length > 0 && <p style={{ color: 'var(--amber)' }}>Файлов с ошибками: {library.invalid.length}</p>}
          <div className="empty__btns">
            <button className="btn btn--primary" onClick={() => void api.openConfigFolder()}>Открыть папку</button>
            <button className="btn" onClick={() => void refresh()}>Обновить</button>
          </div>
        </div>
      ) : (
        <div className={`list ${scroll.className}`} ref={scroll.ref} onScroll={scroll.onScroll} role="listbox" aria-label="Список стран">
          {showAuto && (
            <button className={`row${settings.selectedCountryId === 'auto' ? ' selected' : ''}`} role="option" aria-selected={settings.selectedCountryId === 'auto'} onClick={() => onPick('auto')} onDoubleClick={() => onConnect('auto')}>
              <span className="auto-ico"><IconGlobe /></span>
              <span className="row__name">Авто</span>
              <span className="row__tail">{snap.tunnel.phase === 'connected' && settings.selectedCountryId === 'auto' && <span className="row__live" />}</span>
            </button>
          )}
          {filtered.map((c) => {
            const b = barsFor(c)
            const isSel = settings.selectedCountryId === c.id
            return (
              <button key={c.id} className={`row${isSel ? ' selected' : ''}`} role="option" aria-selected={isSel} onClick={() => onPick(c.id)} onDoubleClick={() => onConnect(c.id)}>
                <Flag code={c.code} size={36} />
                <span className="row__name-wrap">
                  <div>
                    <div className="row__name">{c.nameRu}</div>
                    {c.profiles.length > 1 && <div className="row__sub">{countRu(c.profiles.length, ['сервер', 'сервера', 'серверов'])}</div>}
                  </div>
                  <SignalBars level={b.level} tone={b.tone} size={14} title={b.title} />
                </span>
                <span className="row__tail">{connectedId === c.id && <span className="row__live" title="Подключено" />}</span>
              </button>
            )
          })}
          {filtered.length === 0 && <div className="empty"><p>Ничего не найдено.</p></div>}
        </div>
      )}
      {library.invalid.length > 0 && !empty && (
        <div className="issues">
          {library.invalid.length} {pluralRu(library.invalid.length, ['файл', 'файла', 'файлов'])} не удалось использовать.{' '}
          <button onClick={() => setShowIssues((v) => !v)}>{showIssues ? 'Скрыть' : 'Подробнее'}</button>
          {showIssues && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 16, maxHeight: 90, overflow: 'auto' }}>
              {library.invalid.map((f) => (
                <li key={f.fileName}><b>{f.fileName}</b>: {f.issues.find((i) => i.severity === 'error')?.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
