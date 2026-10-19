// Генерация данных для глобуса: маска суши 0,5° и центры стран (Natural Earth через world-atlas).
// Запускается разработчиком при необходимости; результат (src/renderer/src/globe/*.ts) хранится в репозитории.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { geoArea, geoCentroid } from 'd3-geo'
import { feature } from 'topojson-client'
import countries from 'i18n-iso-countries'

const require = createRequire(import.meta.url)
const land110 = JSON.parse(readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'))
const c50 = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'))

const landFeature = feature(land110, land110.objects.land)
const STEP = 0.5
const W = 360 / STEP
const H = 180 / STEP
const bits = new Uint8Array(Math.ceil((W * H) / 8))
let count = 0
// Растеризация построчно (чёт-нечёт) в плоскости «долгота/широта»: быстро и достаточно точно для сетки 0,5°.
const rings = []
for (const g of landFeature.features ? landFeature.features.map((f) => f.geometry) : [landFeature.geometry]) {
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]
  for (const poly of polys) for (const ring of poly) rings.push(ring)
}
for (let r = 0; r < H; r++) {
  const lat = 90 - (r + 0.5) * STEP
  const xs = []
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j]
      const [x2, y2] = ring[i]
      if (y1 === y2) continue
      if ((y1 <= lat && lat < y2) || (y2 <= lat && lat < y1)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1))
    }
  }
  xs.sort((a, b) => a - b)
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const c0 = Math.max(0, Math.ceil((xs[k] + 180) / STEP - 0.5))
    const c1 = Math.min(W - 1, Math.floor((xs[k + 1] + 180) / STEP - 0.5))
    for (let c = c0; c <= c1; c++) {
      const i = r * W + c
      if (!(bits[i >> 3] & (1 << (i & 7)))) count++
      bits[i >> 3] |= 1 << (i & 7)
    }
  }
}
writeFileSync(
  new URL('../src/renderer/src/globe/landmask.ts', import.meta.url),
  `// Сгенерировано scripts/gen-globe-data.mjs (Natural Earth, общественное достояние). Не редактировать вручную.\n` +
    `export const LAND_STEP = ${STEP}\nexport const LAND_W = ${W}\nexport const LAND_H = ${H}\nexport const LAND_BITS = '${Buffer.from(bits).toString('base64')}'\n`
)
console.log(`маска суши: ${count} из ${W * H} ячеек`)

// Центры стран: центроид крупнейшего многоугольника (чтобы заморские территории не смещали метку).
const feats = feature(c50, c50.objects.countries).features
const out = {}
for (const f of feats) {
  const numeric = String(f.id).padStart(3, '0')
  const a2 = countries.numericToAlpha2(numeric)
  if (!a2) continue
  let geom = f
  if (f.geometry.type === 'MultiPolygon') {
    let best = null
    let bestArea = -1
    for (const poly of f.geometry.coordinates) {
      const g = { type: 'Feature', geometry: { type: 'Polygon', coordinates: poly } }
      const a = geoArea(g)
      if (a > bestArea) {
        bestArea = a
        best = g
      }
    }
    geom = best
  }
  const [lon, lat] = geoCentroid(geom)
  out[a2] = [Math.round(lon * 10) / 10, Math.round(lat * 10) / 10]
}
// Небольшие государства и города, которых нет в 50m (приблизительные координаты столиц)
const extra = { SG: [103.8, 1.35], HK: [114.2, 22.3], MT: [14.4, 35.9], LI: [9.55, 47.15], MC: [7.4, 43.74], MO: [113.55, 22.2], AD: [1.6, 42.5], SM: [12.45, 43.94], BH: [50.55, 26.07], MV: [73.5, 4.2] }
for (const [k, v] of Object.entries(extra)) out[k] ??= v
// Для стран, где центроид не совпадает со столичным регионом, берём ориентир столицы
const capitals = { GB: [-1.5, 52.5], FR: [2.5, 46.6], US: [-97, 39], NL: [5.3, 52.2], NO: [9, 61], RU: [60, 58], CA: [-100, 56], AU: [134, -25], BR: [-52, -10] }
for (const [k, v] of Object.entries(capitals)) out[k] = v
writeFileSync(
  new URL('../src/renderer/src/globe/centers.ts', import.meta.url),
  `// Сгенерировано scripts/gen-globe-data.mjs. Не редактировать вручную.\nexport const COUNTRY_CENTERS: Record<string, [number, number]> = ${JSON.stringify(out)}\n`
)
console.log(`центров стран: ${Object.keys(out).length}`)
