// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SSHConfigForm from './SSHConfigForm'

describe('SSHConfigForm', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows root as the default username and uses host as label', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)

    render(<SSHConfigForm onSave={onSave} onCancel={vi.fn()} />)

    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('root')
    await user.type(screen.getByLabelText('主机'), '192.168.1.100')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        host: '192.168.1.100',
        label: '192.168.1.100',
        username: 'root',
      }))
    })
  })

  it('requires the host field', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)

    render(<SSHConfigForm onSave={onSave} onCancel={vi.fn()} />)

    await user.clear(screen.getByLabelText('主机'))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('请填写主机')).toBeTruthy()
  })

  it('does not silently replace a cleared username with root', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<SSHConfigForm onSave={onSave} onCancel={vi.fn()} />)
    await user.type(screen.getByLabelText('主机'), 'example.test')
    await user.clear(screen.getByLabelText('用户名'))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('请填写用户名')).toBeTruthy()
    expect(screen.getByLabelText('用户名').getAttribute('aria-invalid')).toBe('true')
  })
})
