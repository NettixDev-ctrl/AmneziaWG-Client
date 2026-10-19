import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))

describe('список процессов для раздельного туннелирования', () => {
  it('несколько процессов одного приложения объединяются по полному пути', async () => {
    const { groupProcesses } = await import('../src/main/apps')
    const rows = [
      { ProcessId: 1, Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { ProcessId: 2, Name: 'chrome.exe', ExecutablePath: 'c:\\program files\\google\\chrome\\application\\CHROME.EXE' },
      { ProcessId: 3, Name: 'chrome.exe', ExecutablePath: 'D:\\Portable\\chrome.exe' },
      { ProcessId: 4, Name: 'svchost.exe' },
      { ProcessId: 5, Name: 'bad', ExecutablePath: '\\\\.\\pipe\\evil.exe' }
    ]
    const g = groupProcesses(rows)
    expect(g).toHaveLength(2)
    expect(g.find((x) => x.exePath.startsWith('C:'))?.processes).toBe(2)
    expect(g.find((x) => x.exePath.startsWith('D:'))?.processes).toBe(1)
  })
})
