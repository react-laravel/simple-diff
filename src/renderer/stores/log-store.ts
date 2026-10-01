import { create } from 'zustand'
import type { LogEntry, LogLevel, LogScope } from '../../../shared/types'

const MAX_LOGS = 500
const MAX_MESSAGE_LENGTH = 16 * 1024
const DEFAULT_HEIGHT = 144
const MIN_HEIGHT = 80
const MAX_HEIGHT = 480
const HEIGHT_STORAGE_KEY = 'simple-diff:log-panel-height'

interface LogStore {
  readonly logs: readonly LogEntry[]
  readonly visible: boolean
  readonly height: number
  addLog: (entry: LogEntry) => void
  toggleVisible: () => void
  setVisible: (visible: boolean) => void
  setHeight: (height: number) => void
  clear: () => void
}

function readPersistedHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_HEIGHT
  try {
    const value = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
    if (!value) return DEFAULT_HEIGHT
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return DEFAULT_HEIGHT
    return clampHeight(parsed)
  } catch {
    return DEFAULT_HEIGHT
  }
}

function clampHeight(height: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
}

export const useLogStore = create<LogStore>((set, get) => ({
  logs: [],
  visible: false,
  height: readPersistedHeight(),

  addLog: (entry) => {
    const logs = [...get().logs, { ...entry, message: boundLogMessage(entry.message) }]
    set({ logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs })
  },

  toggleVisible: () => set({ visible: !get().visible }),

  setVisible: (visible) => set({ visible }),

  setHeight: (height) => {
    const next = clampHeight(height)
    set({ height: next })
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(next))
      } catch {
        // ignore quota errors
      }
    }
  },

  clear: () => set({ logs: [] }),
}))

export function addRendererLog(scope: LogScope, level: LogLevel, message: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    scope,
    level,
    message: boundLogMessage(`[renderer] ${message}`),
  }
  if (typeof window !== 'undefined') {
    try {
      window.api?.writeLog(entry)
    } catch {
      // logging must never break renderer behavior
    }
  }

  queueMicrotask(() => {
    useLogStore.getState().addLog(entry)
  })
}

function boundLogMessage(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH)}…[已截断]`
}
