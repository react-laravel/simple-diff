// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { confirmSync, confirmSyncResume } from './confirm-sync'
import SyncConfirmDialog from '../components/overlays/SyncConfirmDialog'
import { useUIStore } from '../stores/ui-store'
import type { StartSyncRequest, SyncTaskSnapshot } from '../../../shared/types'

const request: StartSyncRequest = {
  compareId: 'compare', leftSource: { type: 'local', path: '/left' }, rightSource: { type: 'local', path: '/right' }, direction: 'left_to_right', entries: [],
}

beforeEach(() => {
  useUIStore.setState({ pendingSync: null })
  window.api = {
    prepareSync: vi.fn(async () => ({ success: true, data: { planId: 'plan', files: 17, directories: 3, overwrites: 9 } })),
    prepareSyncResume: vi.fn(async () => ({ success: true, data: { planId: 'resume-plan', files: 5, directories: 1, overwrites: 4 } })),
  } as unknown as Window['api']
})

afterEach(() => { cleanup(); useUIStore.getState().pendingSync?.resolve(false); useUIStore.setState({ pendingSync: null }) })

describe('sync confirmation', () => {
  it('shows expanded backend counts and returns only the confirmed plan token', async () => {
    const user = userEvent.setup()
    render(<SyncConfirmDialog />)
    const result = confirmSync(request)
    expect(await screen.findByText('本次范围：17 个文件、3 个目录。会覆盖 9 个文件。')).toBeTruthy()
    expect(window.api.prepareSync).toHaveBeenCalledWith(request)
    await user.click(screen.getByRole('button', { name: '确认并同步' }))
    expect(await result).toEqual({ ...request, planId: 'plan' })
  })

  it('does not offer confirmation after preflight fails', async () => {
    vi.mocked(window.api.prepareSync).mockResolvedValue({ success: false, error: '目标内容已变更' })
    expect(await confirmSync(request)).toBeNull()
    expect(useUIStore.getState().pendingSync).toBeNull()
  })

  it('requires confirmation of the remaining scope before resume', async () => {
    const user = userEvent.setup()
    render(<SyncConfirmDialog />)
    const task = { ...request, id: 'task', status: 'paused' } as unknown as SyncTaskSnapshot
    const result = confirmSyncResume(task)
    expect(await screen.findByText('剩余范围：5 个文件、1 个目录。会覆盖 4 个文件。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '确认并继续' }))
    expect(await result).toBe('resume-plan')
  })
})
