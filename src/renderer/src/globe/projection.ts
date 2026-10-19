import { LAND_BITS, LAND_H, LAND_STEP, LAND_W } from './landmask'

let mask: Uint8Array | null = null

function getMask(): Uint8Array {
  if (!mask) {
    const bin = atob(LAND_BITS)
    mask = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) mask[i] = bin.charCodeAt(i)
  }
  return mask
}

export function isLand(lonDeg: number, latDeg: number): boolean {
  const m = getMask()
  let lon = ((lonDeg + 180) % 360 + 360) % 360
  if (lon >= 360) lon = 0
  const col = Math.min(LAND_W - 1, Math.floor(lon / LAND_STEP))
  const row = Math.min(LAND_H - 1, Math.max(0, Math.floor((90 - latDeg) / LAND_STEP)))
  const i = row * LAND_W + col
  return (m[i >> 3]! & (1 << (i & 7))) !== 0
}

export interface Dot {
  /** Положение в единичном круге, y вверх. */
  x: number
  y: number
  /** Расстояние от центра, 0..1. */
  r: number
}

/** Точки на концентрических окружностях (как на референсе); spacing — доля радиуса. */
export function ringDots(spacing: number): Dot[] {
  const dots: Dot[] = [{ x: 0, y: 0, r: 0 }]
  for (let ring = 1; ring * spacing < 0.995; ring++) {
    const r = ring * spacing
    const n = Math.max(6, Math.round((2 * Math.PI * r) / spacing))
    const off = ring % 2 ? 0 : Math.PI / n
    for (let k = 0; k < n; k++) {
      const a = off + (k / n) * 2 * Math.PI
      dots.push({ x: r * Math.cos(a), y: r * Math.sin(a), r })
    }
  }
  return dots
}

const RAD = Math.PI / 180

/** Обратная ортографическая проекция: точка круга → (долгота, широта) при центре вида (lon0, lat0). */
export function unproject(x: number, y: number, lon0: number, lat0: number): [number, number] {
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
  const p0 = lat0 * RAD
  const sinp = z * Math.sin(p0) + y * Math.cos(p0)
  const lat = Math.asin(Math.max(-1, Math.min(1, sinp)))
  const lon = lon0 * RAD + Math.atan2(x, z * Math.cos(p0) - y * Math.sin(p0))
  return [lon / RAD, lat / RAD]
}
