import { describe, expect, it } from 'vitest'
import { countRu, formatBytes, formatDuration, pluralRu } from '../src/shared/ru'

describe('русская локализация', () => {
  it('склоняет существительные по числу', () => {
    const f = ['сервер', 'сервера', 'серверов'] as const
    expect(pluralRu(1, f)).toBe('сервер')
    expect(pluralRu(2, f)).toBe('сервера')
    expect(pluralRu(5, f)).toBe('серверов')
    expect(pluralRu(11, f)).toBe('серверов')
    expect(pluralRu(12, f)).toBe('серверов')
    expect(pluralRu(21, f)).toBe('сервер')
    expect(pluralRu(22, f)).toBe('сервера')
    expect(pluralRu(100, f)).toBe('серверов')
    expect(pluralRu(101, f)).toBe('сервер')
    expect(countRu(0, f)).toBe('0 серверов')
  })

  it('форматирует размеры и время', () => {
    expect(formatBytes(0)).toBe('0 Б')
    expect(formatBytes(1536)).toBe('1,5 КБ')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5,0 МБ')
    expect(formatBytes(-1)).toBe('—')
    expect(formatDuration(65)).toBe('01:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})
