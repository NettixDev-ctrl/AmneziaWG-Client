import type { ReactNode, SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = (p: P): P => ({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, ...p })

export const IconHome = (p: P): ReactNode => (
  <svg {...base(p)}><path d="M12 3.2 3.2 10.4V20a1 1 0 0 0 1 1h4.6v-6.200h6.400V21h4.600a1 1 0 0 0 1-1v-9.600L12 3.200Z" fill="currentColor" /></svg>
)
export const IconGear = (p: P): ReactNode => (
  <svg {...base(p)}>
    <path fill="currentColor" d="M10.300 2.600h3.400l.6 2.500c.5.200 1 .5 1.500.8l2.400-.8 1.700 3-1.900 1.700c.1.600.1 1.100 0 1.700l1.900 1.700-1.700 3-2.400-.8c-.4.300-1 .6-1.500.8l-.6 2.500h-3.400l-.6-2.500c-.5-.2-1-.5-1.500-.8l-2.400.8-1.700-3 1.900-1.700a6 6 0 0 1 0-1.700L4.100 8.100l1.700-3 2.400.8c.4-.3 1-.6 1.500-.8l.6-2.500Z" />
    <circle cx="12" cy="12" r="2.600" fill="var(--icon-hole, #1c1c1e)" />
  </svg>
)
export const IconHeadset = (p: P): ReactNode => (
  <svg {...base({ width: 22, height: 22, ...p })} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="3" y="13" width="4" height="6" rx="1.600" fill="currentColor" />
    <rect x="17" y="13" width="4" height="6" rx="1.600" fill="currentColor" />
    <path d="M19 19c0 1.700-2 2.500-5 2.500" />
  </svg>
)
export const IconCheck = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="2.200" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.500 4.500 4.500L19 7.500" /></svg>
)
export const IconSparkle = (p: P): ReactNode => (
  <svg {...base(p)} fill="currentColor">
    <path d="M10 3.500 11.600 8.400 16.500 10 11.600 11.600 10 16.500 8.400 11.600 3.500 10 8.400 8.400Z" />
    <path d="M17.500 13.500 18.300 15.700 20.500 16.500 18.300 17.300 17.500 19.500 16.700 17.300 14.500 16.500 16.700 15.700Z" />
    <path d="M17.200 3.500 17.800 5.200 19.500 5.800 17.800 6.400 17.200 8.100 16.600 6.400 14.900 5.800 16.600 5.200Z" />
  </svg>
)
export const IconBolt = (p: P): ReactNode => (
  <svg {...base(p)} fill="currentColor"><path d="M13.500 2.500 5 13.500h6l-1 8 8.500-11h-6l1-8Z" /></svg>
)
export const IconPuzzle = (p: P): ReactNode => (
  <svg {...base(p)} fill="currentColor">
    <path d="M10.500 3.500a2 2 0 1 1 3.800.8H18a1 1 0 0 1 1 1V9a2 2 0 1 0 0 3.800V17a1 1 0 0 1-1 1h-3.700a2 2 0 1 0-3.800 0H6a1 1 0 0 1-1-1v-3.700a2 2 0 1 1 0-3.800V5.300a1 1 0 0 1 1-1h3.700c-.1-.2-.2-.5-.2-.8Z" transform="translate(0 1.500) scale(.96)" />
  </svg>
)
export const IconHelp = (p: P): ReactNode => (
  <svg {...base({ width: 16, height: 16, ...p })}>
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="M9.400 9.300a2.700 2.700 0 1 1 3.800 2.500c-.8.400-1.200.9-1.200 1.800" stroke="var(--icon-hole, #1c1c1e)" strokeWidth="2.200" strokeLinecap="round" />
    <circle cx="12" cy="17" r="1.300" fill="var(--icon-hole, #1c1c1e)" />
  </svg>
)
export const IconGlobe = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="1.800" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3.200 3.400 3.200 14.600 0 18M12 3c-3.200 3.400-3.200 14.600 0 18" />
  </svg>
)
export const IconSearch = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="6.500" /><path d="m16 16 4.500 4.500" /></svg>
)
export const IconRefresh = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 0 0-14.500-4.200M4 4v4h4M4 13a8 8 0 0 0 14.500 4.200M20 20v-4h-4" /></svg>
)
export const IconFolder = (p: P): ReactNode => (
  <svg {...base(p)} fill="currentColor"><path d="M3 6.500A1.500 1.500 0 0 1 4.500 5h4.200l2 2.200h8.800A1.500 1.500 0 0 1 21 8.700v8.800a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 17.500v-11Z" /></svg>
)
export const IconPlus = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="2.200" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
)
export const IconTrash = (p: P): ReactNode => (
  <svg {...base(p)} stroke="currentColor" strokeWidth="1.800" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" /></svg>
)
export const IconWarn = (p: P): ReactNode => (
  <svg {...base(p)} fill="currentColor"><path d="M12 3 2 20h20L12 3Zm-1 7h2v5h-2v-5Zm0 6.500h2v2h-2v-2Z" /></svg>
)

/** Столбики уровня сигнала. level: 0 — не измерено (приглушённые), 1–3 — измеренное качество. */
export function SignalBars({ level, tone, size = 16, title }: { level: 0 | 1 | 2 | 3; tone: 'good' | 'fair' | 'poor' | 'unknown'; size?: number; title?: string }): ReactNode {
  const heights = [0.4, 0.62, 0.84, 1]
  const lit = level === 0 ? 0 : level + 1
  return (
    <span className={`bars bars--${tone}`} style={{ height: size, width: size * 1.05 }} title={title} role="img" aria-label={title ?? 'Уровень сигнала'}>
      {heights.map((h, i) => (
        <i key={i} className={i < lit ? 'on' : ''} style={{ height: `${h * 100}%` }} />
      ))}
    </span>
  )
}
