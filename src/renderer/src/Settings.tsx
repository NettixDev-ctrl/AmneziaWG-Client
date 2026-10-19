import { useEffect, useState, type ReactNode } from 'react'
import type { AppSnapshot, DiagnosticsInfo } from '../../shared/ipc'
import { countRu, formatBytes, formatDuration } from '../../shared/ru'
import type { Settings, SettingsPatch } from '../../shared/settings'
import { useApi } from './api'
import { IconFolder, IconRefresh } from './icons'
import { SplitSection } from './SplitSection'
import { Row, Segmented, Toggle } from './ui'

type Section = 'connection' | 'split' | 'network' | 'app' | 'diag'
const SECTIONS: Array<{ id: Section; title: string }> = [
  { id: 'connection', title: 'Подключение' },
  { id: 'split', title: 'Раздельное туннелирование' },
  { id: 'network', title: 'Сеть' },
  { id: 'app', title: 'Приложение' },
  { id: 'diag', title: 'Диагностика' }
]

export function SettingsPage({ snap, notify, initial }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void; initial?: Section }): ReactNode {
  const [section, setSection] = useState<Section>(initial ?? 'connection')
  return (
    <div className="settings">
      <nav className="card snav" aria-label="Разделы настроек">
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? 'active' : ''} aria-current={section === s.id} onClick={() => setSection(s.id)}>
            {s.title}
          </button>
        ))}
      </nav>
      <section className="card spanel">
        <div className="spanel__scroll">
          <div className="sec-anim" key={section}>
          {section === 'connection' && <ConnectionSection snap={snap} notify={notify} />}
          {section === 'split' && <SplitSection snap={snap} notify={notify} />}
          {section === 'network' && <NetworkSection snap={snap} notify={notify} />}
          {section === 'app' && <AppSection snap={snap} notify={notify} />}
          {section === 'diag' && <DiagSection snap={snap} notify={notify} />}
          </div>
        </div>
      </section>
    </div>
  )
}

function usePatch(notify: (m: string, e?: boolean) => void): (p: SettingsPatch) => void {
  const api = useApi()
  return (p) => {
    void api.setSettings(p).then((r) => {
      if (!r.ok) notify(r.error, true)
    })
  }
}

function ConnectionSection({ snap, notify }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void }): ReactNode {
  const patch = usePatch(notify)
  const s = snap.settings
  return (
    <>
      <h2>Подключение</h2>
      <p className="lead">Поведение при запуске, выборе сервера и потере соединения.</p>
      <Row label="Тип подключения" desc="Авто — лучший сервер по измеренной задержке с переходом к следующему при неудаче. Быстрый — минимальная задержка. Адаптивный — применяются правила раздельного туннелирования.">
        <Segmented value={s.connectionMode} onChange={(v) => patch({ connectionMode: v })} options={[{ value: 'auto', label: 'Авто' }, { value: 'fast', label: 'Быстрый' }, { value: 'adaptive', label: 'Адаптивный' }]} />
      </Row>
      <Row label="Страна по умолчанию" desc="Используется кнопкой подключения и при автоматическом подключении.">
        <select className="select" aria-label="Страна по умолчанию" value={s.defaultCountryId} onChange={(e) => patch({ defaultCountryId: e.target.value })}>
          <option value="last">Последняя использованная</option>
          <option value="auto">Выбирать автоматически</option>
          {snap.library.countries.map((c) => <option key={c.id} value={c.id}>{c.nameRu}</option>)}
        </select>
      </Row>
      <Row label="Подключаться автоматически" desc="Сразу после запуска приложения.">
        <Toggle label="Подключаться автоматически" checked={s.autoConnect} onChange={(v) => patch({ autoConnect: v })} />
      </Row>
      <Row label="Переподключаться при потере соединения" desc="Повторные попытки с нарастающей паузой; после выхода из сна проверка выполняется сразу.">
        <Toggle label="Переподключаться при потере соединения" checked={s.reconnectOnLoss} onChange={(v) => patch({ reconnectOnLoss: v })} />
      </Row>
      <Row label="При запуске окно">
        <Segmented value={s.startBehavior} onChange={(v) => patch({ startBehavior: v })} options={[{ value: 'show', label: 'Показывать' }, { value: 'minimized', label: 'В трей' }]} />
      </Row>
    </>
  )
}

function NetworkSection({ snap, notify }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void }): ReactNode {
  const api = useApi()
  const patch = usePatch(notify)
  const n = snap.settings.network
  const [dns, setDns] = useState(n.dnsServers.join(', '))
  const [mtu, setMtu] = useState(String(n.mtu))
  const [busy, setBusy] = useState(false)
  useEffect(() => setDns(n.dnsServers.join(', ')), [n.dnsServers])
  useEffect(() => setMtu(String(n.mtu)), [n.mtu])

  const commitDns = (): void => {
    const list = dns.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
    patch({ network: { dnsServers: list } } as SettingsPatch)
  }
  const commitMtu = (): void => {
    const v = Number(mtu)
    if (!Number.isInteger(v) || v < 576 || v > 1500) return notify('MTU должен быть числом от 576 до 1500.', true)
    patch({ network: { mtu: v } } as SettingsPatch)
  }
  return (
    <>
      <h2>Сеть</h2>
      <p className="lead">Изменения применяются при следующем подключении (если туннель активен, он переподключится автоматически).</p>
      <Row label="DNS-серверы" desc="По умолчанию используются серверы из конфигурации. Запросы DNS к другим серверам блокируются, чтобы исключить утечки.">
        <Segmented value={n.dnsMode} onChange={(v) => patch({ network: { dnsMode: v } } as SettingsPatch)} options={[{ value: 'config', label: 'Из конфигурации' }, { value: 'custom', label: 'Свои' }]} />
      </Row>
      {n.dnsMode === 'custom' && (
        <Row label="Адреса DNS" desc="IPv4 или IPv6 через запятую, не более четырёх.">
          <input className="field" style={{ width: 260 }} value={dns} onChange={(e) => setDns(e.target.value)} onBlur={commitDns} onKeyDown={(e) => e.key === 'Enter' && commitDns()} placeholder="1.1.1.1, 9.9.9.9" aria-label="Адреса DNS" />
        </Row>
      )}
      <Row label="MTU" desc="Размер пакета туннеля. Уменьшите, если часть сайтов не открывается.">
        <Segmented value={n.mtuMode} onChange={(v) => patch({ network: { mtuMode: v } } as SettingsPatch)} options={[{ value: 'config', label: 'Из конфигурации' }, { value: 'custom', label: 'Свой' }]} />
        {n.mtuMode === 'custom' && <input className="field" style={{ width: 84 }} inputMode="numeric" value={mtu} onChange={(e) => setMtu(e.target.value)} onBlur={commitMtu} onKeyDown={(e) => e.key === 'Enter' && commitMtu()} aria-label="MTU" />}
      </Row>
      <Row label="IPv6" desc={n.ipv6 === 'tunnel' ? 'Весь IPv6-трафик направляется в туннель; если сервер IPv6 не поддерживает, он отбрасывается — утечек нет.' : 'IPv6 не направляется в туннель и идёт напрямую. Защиты от утечек IPv6 нет.'}>
        <Segmented value={n.ipv6} onChange={(v) => patch({ network: { ipv6: v } } as SettingsPatch)} options={[{ value: 'tunnel', label: 'В туннеле' }, { value: 'system', label: 'Системный' }]} />
      </Row>
      <Row label="Kill switch" desc={n.localNetwork ? 'Недоступен при включённом доступе к локальной сети.' : 'Брандмауэр блокирует весь трафик вне туннеля, пока он активен. Правила действуют только пока работает служба туннеля и снимаются при её остановке.'}>
        <Toggle label="Kill switch" checked={n.killSwitch && !n.localNetwork} disabled={n.localNetwork} onChange={(v) => patch({ network: { killSwitch: v } } as SettingsPatch)} />
      </Row>
      <Row label="Доступ к локальной сети" desc="Принтеры, NAS и другие устройства в вашей сети остаются доступны. Несовместимо с kill switch: он блокирует и локальную сеть.">
        <Toggle label="Доступ к локальной сети" checked={n.localNetwork} onChange={(v) => patch({ network: { localNetwork: v } } as SettingsPatch)} />
      </Row>
      <Row label="Восстановление после сбоя" desc="При запуске отключать туннель, оставшийся после аварийного завершения.">
        <Toggle label="Восстановление после сбоя" checked={n.recoverOnStart} onChange={(v) => patch({ network: { recoverOnStart: v } } as SettingsPatch)} />
      </Row>
      <Row label="Восстановить сеть" desc="Останавливает туннель, удаляет его службу, адаптер, правила брандмауэра и временные файлы.">
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); const r = await api.recoverNetwork(); setBusy(false); notify(r.ok ? 'Сетевое состояние восстановлено.' : r.error, !r.ok) }}>
          {busy ? 'Выполняется…' : 'Восстановить'}
        </button>
      </Row>
    </>
  )
}

function AppSection({ snap, notify }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void }): ReactNode {
  const api = useApi()
  const patch = usePatch(notify)
  const a: Settings['app'] = snap.settings.app
  const isWin = snap.platform === 'win32'
  return (
    <>
      <h2>Приложение</h2>
      <p className="lead">Запуск, поведение окна, тема и расположение конфигураций.</p>
      <Row label="Запускать вместе с Windows" desc={isWin ? undefined : 'Доступно в Windows (в установленной версии).'}>
        <Toggle label="Запускать вместе с Windows" checked={a.startWithWindows} onChange={(v) => patch({ app: { startWithWindows: v } } as SettingsPatch)} />
      </Row>
      <Row label="Сворачивать в трей">
        <Toggle label="Сворачивать в трей" checked={a.minimizeToTray} onChange={(v) => patch({ app: { minimizeToTray: v } } as SettingsPatch)} />
      </Row>
      <Row label="Закрытие окна — в трей" desc="Иначе закрытие окна завершает приложение и отключает VPN.">
        <Toggle label="Закрытие окна — в трей" checked={a.closeToTray} onChange={(v) => patch({ app: { closeToTray: v } } as SettingsPatch)} />
      </Row>
      <Row label="Уведомления" desc="О подключении, потере соединения и ошибках.">
        <Toggle label="Уведомления" checked={a.notifications} onChange={(v) => patch({ app: { notifications: v } } as SettingsPatch)} />
      </Row>
      <Row label="Язык интерфейса">
        <select className="select" aria-label="Язык интерфейса" value="ru" onChange={() => undefined}>
          <option value="ru">Русский</option>
        </select>
      </Row>
      <Row label="Тема">
        <Segmented value={a.theme} onChange={(v) => patch({ app: { theme: v } } as SettingsPatch)} options={[{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }, { value: 'system', label: 'Как в системе' }]} />
      </Row>
      <Row label="Папка конфигураций" desc={<span style={{ userSelect: 'text', wordBreak: 'break-all' }}>{snap.library.configDir}{a.configDir === null ? ' (рядом с программой)' : ''}</span>}>
        <button className="btn" onClick={() => void api.openConfigFolder()}><IconFolder /> Открыть</button>
        <button className="btn" onClick={() => void api.chooseConfigFolder()}>Изменить…</button>
        {a.configDir !== null && <button className="btn" onClick={() => patch({ app: { configDir: null } } as SettingsPatch)}>Сбросить</button>}
      </Row>
      <Row label="Следить за папкой" desc="Новые и удалённые .conf появляются в списке стран автоматически.">
        <Toggle label="Следить за папкой" checked={a.watchConfigDir} onChange={(v) => patch({ app: { watchConfigDir: v } } as SettingsPatch)} />
        <button className="btn" onClick={() => void api.refreshConfigs()}><IconRefresh /> Обновить</button>
      </Row>
    </>
  )
}

function DiagSection({ snap, notify }: { snap: AppSnapshot; notify: (m: string, e?: boolean) => void }): ReactNode {
  const api = useApi()
  const [diag, setDiag] = useState<DiagnosticsInfo | null>(null)
  const load = (): void => {
    void api.getDiagnostics().then((r) => r.ok && setDiag(r.value))
  }
  useEffect(load, [api])
  const t = snap.tunnel
  const hs = t.handshakeAgeSec
  const phaseText: Record<string, string> = {
    idle: 'Отключено', starting: 'Запуск службы', handshaking: 'Ожидание рукопожатия', connected: 'Подключено',
    degraded: 'Рукопожатие устарело', stopping: 'Остановка', failed: 'Ошибка'
  }
  const h = snap.helper
  return (
    <>
      <h2>Диагностика</h2>
      <p className="lead">Реальное состояние туннеля. «Подключено» показывается только при свежем рукопожатии с сервером.</p>
      <dl className="kv">
        <dt>Состояние туннеля</dt>
        <dd className={t.phase === 'connected' ? 'good' : t.phase === 'failed' ? 'bad' : t.phase === 'degraded' ? 'warn' : ''}>{phaseText[t.phase] ?? t.phase}</dd>
        <dt>Рукопожатие</dt>
        <dd>{hs === null ? 'ещё не выполнено' : `${formatDuration(hs)} назад`}</dd>
        <dt>Трафик (принято / отправлено)</dt>
        <dd>{formatBytes(t.rxBytes)} / {formatBytes(t.txBytes)}</dd>
        <dt>Ошибка соединения</dt>
        <dd className={t.error ? 'bad' : ''}>{t.error ? `${t.error}${t.errorCode ? ` (${t.errorCode})` : ''}` : 'нет'}</dd>
        <dt>Служба AmneziaWG Client</dt>
        <dd className={h.state === 'ok' ? 'good' : 'bad'}>{h.state === 'ok' ? `работает, версия ${h.version}` : h.state === 'unknown' ? 'проверка…' : h.message}</dd>
        <dt>Раздельное туннелирование</dt>
        <dd className={snap.split.state === 'failed' ? 'bad' : ''}>{snap.split.state === 'off' ? 'не используется' : snap.split.state === 'running' ? `работает, потоков: ${snap.split.activeFlows}` : snap.split.state === 'starting' ? 'запускается' : snap.split.error ?? 'ошибка'}</dd>
        <dt>Конфигурации</dt>
        <dd>{countRu(snap.library.totalFiles, ['файл', 'файла', 'файлов'])}, стран: {snap.library.countries.length}, с ошибками: {snap.library.invalid.length}{snap.library.duplicateFiles.length ? `, дубликатов: ${snap.library.duplicateFiles.length}` : ''}</dd>
        <dt>Версия приложения</dt>
        <dd>{snap.appVersion}</dd>
      </dl>

      {snap.library.invalid.length > 0 && (
        <div className="note note--warn">
          <b>Файлы с ошибками</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {snap.library.invalid.map((f) => <li key={f.fileName}><b>{f.fileName}</b>: {f.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}</li>)}
          </ul>
        </div>
      )}

      <Row label="Журнал" desc="Ключи и адреса в журнале скрыты." stack>
        <div className="logbox" tabIndex={0} aria-label="Журнал">{diag ? diag.logs.join('\n') || 'Журнал пуст.' : 'Загрузка…'}</div>
      </Row>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button className="btn" onClick={load}><IconRefresh /> Обновить журнал</button>
        <button className="btn btn--primary" onClick={async () => { const r = await api.exportDiagnostics(); if (!r.ok) notify(r.error, true); else if (r.value) notify('Диагностика сохранена.') }}>Экспорт диагностики…</button>
      </div>
    </>
  )
}
