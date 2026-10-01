import { afterEach, expect, it, vi } from 'vitest'
import type { CompareEntry } from '@shared/types'
import { computeVisibleTreeNodesAsync } from './compare-tree-client'
import { decodeVisibleTreeNodes, prepareVisibleTreeProjection, type CompareTreeResult } from './compare-tree-protocol'

const options = { filter: 'all' as const, pathFilter: [], hideDot: false, hideDotFilter: 'all' as const }
const entries: CompareEntry[] = [
  { relativePath: 'z.txt', name: 'z.txt', isDirectory: false, state: 'equal', reasons: [] },
  { relativePath: 'docs/a.txt', name: 'a.txt', isDirectory: false, state: 'left_only', reasons: [] },
  { relativePath: 'docs', name: 'docs', isDirectory: true, state: 'equal', reasons: [] },
]

class TestWorker {
  static instances: TestWorker[] = []
  onmessage?: (event: { data: CompareTreeResult }) => void
  onerror?: () => void
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() { TestWorker.instances.push(this) }
  finish() { this.onmessage?.({ data: prepareVisibleTreeProjection({ entries, options, expandedDirs: ['docs'] }) }) }
}
afterEach(() => { vi.unstubAllGlobals(); TestWorker.instances = [] })

it('keeps collapsed ancestors and their aggregate state without exposing hidden children', () => {
  const projection = prepareVisibleTreeProjection({ entries, options, expandedDirs: [] })
  const nodes = decodeVisibleTreeNodes(entries, projection)
  expect(nodes.toPathArray()).toEqual(['docs', 'z.txt'])
  expect(nodes.get(0)?.entry?.state).toBe('different')
  expect(nodes.hasPath('docs')).toBe(true)
  expect(nodes.hasPath('docs/a.txt')).toBe(false)
  expect(nodes.get(0)?.entry?.relativePath).toBe('docs')
  expect(entries[2].state).toBe('equal')
})

it('filters large trees while preserving directories that contain matching differences', () => {
  const many: CompareEntry[] = [...entries, ...Array.from({ length: 50_001 }, (_, index): CompareEntry => ({
    relativePath: `equal-${index}.txt`, name: `equal-${index}.txt`, isDirectory: false, state: 'equal', reasons: [],
  }))]
  const nodes = decodeVisibleTreeNodes(many, prepareVisibleTreeProjection({
    entries: many, options: { ...options, filter: 'different' }, expandedDirs: ['docs'],
  }))
  expect(nodes.toPathArray()).toEqual(['docs', 'docs/a.txt'])
  expect(nodes.slice(-1)[0].depth).toBe(1)
  expect(nodes.hasPath('docs/a.txt')).toBe(true)
  expect(nodes.hasPath('equal-100.txt')).toBe(false)
})

it('terminates cancelled work and ignores a late worker response', async () => {
  vi.stubGlobal('Worker', TestWorker)
  const controller = new AbortController()
  const result = computeVisibleTreeNodesAsync(entries, options, new Set(['docs']), controller.signal)
  controller.abort()
  TestWorker.instances[0].finish()
  expect(await result).toBeNull()
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

it('returns current entries from a worker projection and releases the worker', async () => {
  vi.stubGlobal('Worker', TestWorker)
  const result = computeVisibleTreeNodesAsync(entries, options, new Set(['docs']), new AbortController().signal)
  TestWorker.instances[0].finish()
  expect((await result)?.toPathArray()).toEqual(['docs', 'docs/a.txt', 'z.txt'])
  expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
})
