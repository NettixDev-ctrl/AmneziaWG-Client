import type { ReactNode } from 'react'

// Флаги — набор flag-icons (MIT), квадратные SVG, вшиваются в сборку: работает офлайн и на Windows,
// где эмодзи-флаги не отображаются.
const FLAGS = import.meta.glob('../../../node_modules/flag-icons/flags/1x1/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string | { default: string }>

const BY_CODE: Record<string, string> = {}
for (const [path, url] of Object.entries(FLAGS)) {
  const m = /\/([a-z-]+)\.svg$/.exec(path)
  if (m) BY_CODE[m[1]!] = typeof url === 'string' ? url : url.default
}

export function Flag({ code, size = 36 }: { code: string | null; size?: number }): ReactNode {
  const url = code ? BY_CODE[code.toLowerCase()] : undefined
  const style = { width: size, height: size }
  if (!url) {
    return (
      <span className="flag flag--generic" style={style} aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c3 3.2 3 14.800 0 18M12 3c-3 3.2-3 14.800 0 18" />
        </svg>
      </span>
    )
  }
  return <span className="flag" style={{ ...style, backgroundImage: `url("${url}")` }} aria-hidden />
}
