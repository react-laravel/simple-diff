import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCompareStore } from '../stores/compare-store'
import { applyOpenedLocalPaths } from './open-paths'

function resetSources(): void {
  useCompareStore.setState({
    leftPath: '',
    rightPath: '',
    leftSourceType: 'local',
    rightSourceType: 'sftp',
    leftSSHConfigId: '',
    rightSSHConfigId: 'old',
  })
}

afterEach(() => {
  resetSources()
})

describe('applyOpenedLocalPaths', () => {
  it('fills the left side and stays on the compare setup for a single folder', () => {
    resetSources()
    const setPage = vi.fn()
    const runCompare = vi.fn()

    expect(applyOpenedLocalPaths([' /Users/sam/left '], { setPage, runCompare })).toBe(true)

    const state = useCompareStore.getState()
    expect(state.leftPath).toBe('/Users/sam/left')
    expect(state.leftSourceType).toBe('local')
    expect(state.rightPath).toBe('')
    expect(setPage).toHaveBeenCalledWith('compare')
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('fills both sides and starts compare when two folders are opened', () => {
    resetSources()
    const setPage = vi.fn()
    const runCompare = vi.fn()

    applyOpenedLocalPaths(['/left', '/right'], { setPage, runCompare })

    const state = useCompareStore.getState()
    expect(state.leftPath).toBe('/left')
    expect(state.rightPath).toBe('/right')
    expect(state.rightSourceType).toBe('local')
    expect(state.rightSSHConfigId).toBe('')
    expect(setPage).toHaveBeenCalledWith('compare')
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it('fills the right side when the left path is already set', () => {
    resetSources()
    useCompareStore.setState({ leftPath: '/Users/sam/left', rightPath: '' })
    const setPage = vi.fn()
    const runCompare = vi.fn()

    applyOpenedLocalPaths(['/Users/sam/right'], { setPage, runCompare })

    const state = useCompareStore.getState()
    expect(state.leftPath).toBe('/Users/sam/left')
    expect(state.rightPath).toBe('/Users/sam/right')
    expect(state.rightSourceType).toBe('local')
    expect(state.rightSSHConfigId).toBe('')
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('ignores empty payloads', () => {
    resetSources()
    const setPage = vi.fn()
    expect(applyOpenedLocalPaths(['', '  '], { setPage, runCompare: vi.fn() })).toBe(false)
    expect(setPage).not.toHaveBeenCalled()
  })
})
