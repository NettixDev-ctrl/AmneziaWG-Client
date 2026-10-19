import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }): ReactNode {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="toggle" onClick={() => onChange(!checked)} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }): ReactNode {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Row({ label, desc, children, stack }: { label: string; desc?: ReactNode; children?: ReactNode; stack?: boolean }): ReactNode {
  return (
    <div className={`srow${stack ? ' srow--stack' : ''}`}>
      <div className="srow__text">
        <div className="srow__label">{label}</div>
        {desc && <div className="srow__desc">{desc}</div>}
      </div>
      {children && <div className="srow__control">{children}</div>}
    </div>
  )
}

/** Список с тонким полосатым индикатором прокрутки, появляющимся при наведении или прокрутке. */
export function useScrollingClass(): { ref: React.RefObject<HTMLDivElement | null>; className: string; onScroll: () => void } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrolling, setScrolling] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return {
    ref,
    className: scrolling ? 'scrolling' : '',
    onScroll: () => {
      setScrolling(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setScrolling(false), 900)
    }
  }
}

export function Toast({ message, error }: { message: string | null; error?: boolean }): ReactNode {
  if (!message) return null
  return <div className={`toast${error ? ' err' : ''}`} role="status">{message}</div>
}

export function useToast(): { message: string | null; error: boolean; show: (m: string, err?: boolean) => void } {
  const [state, setState] = useState<{ message: string | null; error: boolean }>({ message: null, error: false })
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return {
    ...state,
    show: (m, err = false) => {
      setState({ message: m, error: err })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setState({ message: null, error: false }), 4200)
    }
  }
}
