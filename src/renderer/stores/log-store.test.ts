import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '../../../shared/types'
import { useLogStore } from './log-store'

function resetLogStore(): void {
  useLogStore.setState({ logs: [], visible: false })
}

function createLogEntry(index: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: index,
    level: 'info',
    scope: 'compare',
    message: `log-${index}`,
    ...overrides,
  }
}

describe('log-store', () => {
  beforeEach(() => {
    resetLogStore()
  })

  afterEach(() => {
    resetLogStore()
  })

  it('preserves log scope metadata', () => {
    useLogStore.getState().addLog(createLogEntry(1, { scope: 'sync', message: 'syncing' }))

    expect(useLogStore.getState().logs).toEqual([
      expect.objectContaining({ scope: 'sync', message: 'syncing' }),
    ])
  })

  it('keeps only the latest 500 logs', () => {
    const store = useLogStore.getState()

    for (let index = 0; index < 505; index += 1) {
      store.addLog(createLogEntry(index))
    }

    const logs = useLogStore.getState().logs
    expect(logs).toHaveLength(500)
    expect(logs[0]?.message).toBe('log-5')
    expect(logs.at(-1)?.message).toBe('log-504')
  })

  it('bounds individual messages before storing them', () => {
    useLogStore.getState().addLog(createLogEntry(1, { message: 'x'.repeat(100_000) }))
    const message = useLogStore.getState().logs[0].message
    expect(message.length).toBeLessThan(16 * 1024 + 32)
    expect(message).toContain('[已截断]')
  })

  it('allows forcing the panel open when selecting compare tabs', () => {
    useLogStore.getState().setVisible(true)
    expect(useLogStore.getState().visible).toBe(true)

    useLogStore.getState().setVisible(false)
    expect(useLogStore.getState().visible).toBe(false)
  })
})
