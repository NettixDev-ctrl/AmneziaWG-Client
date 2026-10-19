import { useEffect, useRef, type ReactNode } from 'react'
import { COUNTRY_CENTERS } from './globe/centers'
import { isLand, ringDots, unproject } from './globe/projection'

export type GlobeTone = 'idle' | 'busy' | 'on' | 'warn' | 'error'

interface Props {
  /** Код страны, на которую «смотрит» глобус; null — обзор Европы. */
  countryCode: string | null
  tone: GlobeTone
}

const DEFAULT_VIEW: [number, number] = [18, 48]
const DOTS = ringDots(0.0235)

function viewFor(code: string | null): [number, number] {
  const c = code ? COUNTRY_CENTERS[code] : undefined
  return c ? [c[0], c[1]] : DEFAULT_VIEW
}

const TONE_RGB: Record<GlobeTone, string> = {
  idle: '110,120,140',
  busy: '110,150,255',
  on: '70,120,255',
  warn: '240,170,40',
  error: '235,90,90'
}

/** Точечный глобус: холст рисуется заново только при вращении (плавный переход к выбранной стране). */
export function Globe({ countryCode, tone }: Props): ReactNode {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const state = useRef({ lon: DEFAULT_VIEW[0], lat: DEFAULT_VIEW[1], tLon: DEFAULT_VIEW[0], tLat: DEFAULT_VIEW[1], raf: 0, size: 0, dpr: 1 })

  const draw = (): void => {
    const cv = canvas.current
    if (!cv) return
    const s = state.current
    const ctx = cv.getContext('2d')
    if (!ctx || s.size === 0) return
    const px = s.size * s.dpr
    if (cv.width !== px) {
      cv.width = px
      cv.height = px
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, px, px)
    const R = (px / 2) * 0.985
    const cx = px / 2
    const cy = px / 2

    // Лёгкое свечение шара
    const g = ctx.createRadialGradient(cx - R * 0.15, cy - R * 0.2, R * 0.05, cx, cy, R)
    g.addColorStop(0, 'rgba(255,255,255,0.035)')
    g.addColorStop(0.7, 'rgba(255,255,255,0.012)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    const dotLand = Math.max(1, R * 0.0066)
    const dotSea = Math.max(0.65, R * 0.0036)
    for (const d of DOTS) {
      const [lon, lat] = unproject(d.x, d.y, s.lon, s.lat)
      const land = isLand(lon, lat)
      // Затемнение к краю (лимб) и тонкое смещение яркости по долготе даёт объём
      const shade = Math.pow(1 - d.r * d.r, 0.55)
      const a = land ? 0.13 + 0.55 * shade : 0.035 + 0.14 * shade
      ctx.fillStyle = land ? `rgba(228,230,238,${a.toFixed(3)})` : `rgba(180,186,200,${a.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(cx + d.x * R, cy - d.y * R, land ? dotLand : dotSea, 0, Math.PI * 2)
      ctx.fill()
    }
    // Виньетка по краю
    const v = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.02)
    v.addColorStop(0, 'rgba(12,12,13,0)')
    v.addColorStop(1, 'rgba(12,12,13,0.78)')
    ctx.fillStyle = v
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2)
    ctx.fill()
  }

  const loop = (): void => {
    const s = state.current
    let dLon = s.tLon - s.lon
    if (dLon > 180) dLon -= 360
    if (dLon < -180) dLon += 360
    const dLat = s.tLat - s.lat
    if (Math.abs(dLon) < 0.05 && Math.abs(dLat) < 0.05) {
      s.lon = s.tLon
      s.lat = s.tLat
      draw()
      s.raf = 0
      return
    }
    s.lon += dLon * 0.085
    s.lat += dLat * 0.085
    draw()
    s.raf = requestAnimationFrame(loop)
  }

  useEffect(() => {
    const [lon, lat] = viewFor(countryCode)
    const s = state.current
    s.tLon = lon
    s.tLat = lat
    if (!s.raf) s.raf = requestAnimationFrame(loop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const s = state.current
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      s.size = Math.floor(Math.min(el.clientWidth, el.clientHeight))
      const cv = canvas.current
      if (cv) {
        cv.style.width = `${s.size}px`
        cv.style.height = `${s.size}px`
      }
      draw()
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(state.current.raf)
      state.current.raf = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasMarker = countryCode !== null && COUNTRY_CENTERS[countryCode] !== undefined
  return (
    <div className="globe" ref={wrap} style={{ ['--tone' as string]: TONE_RGB[tone] }}>
      <canvas ref={canvas} className="globe__canvas" />
      {hasMarker && (
        <span className={`globe__marker globe__marker--${tone}`}>
          <i />
        </span>
      )}
    </div>
  )
}
