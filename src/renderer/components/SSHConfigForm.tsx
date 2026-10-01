import { useState } from 'react'
import type { SSHConfig, SSHConfigInput, SSHAuthType } from '../../../shared/types'
import { Check, Folder } from 'lucide-react'
import { Button, Field, Input, Panel, RadioGroup } from './ui'

interface SSHConfigFormProps {
  readonly initial?: SSHConfig
  readonly onSave: (config: SSHConfigInput) => Promise<void>
  readonly onCancel: () => void
}

const AUTH_TYPES: { value: SSHAuthType; label: string }[] = [
  { value: 'password', label: '密码' },
  { value: 'privateKey', label: 'SSH Key' },
]

/**
 * chunk 10 扫描项 4 / 5：这份表单原来是六个手写 `<input>`（每个都自己关掉了
 * outline 再补一圈 1px 的 ring，等于绕过统一焦点环）、一条手搓的分段按钮条和两个
 * 手搓按钮。全部换成 `Field` / `Input` / `RadioGroup variant="segmented"` / `Button`，
 * 焦点环、失效态和 `aria-describedby` 从此由基元统一负责。
 *
 * 注：注释里不要再写出那两个类名的字面量——Tailwind 的扫描器连注释一起读，
 * 会把它们当成真在用的类，凭空生成一条能压过焦点环的 utility。
 */
export default function SSHConfigForm({ initial, onSave, onCancel }: SSHConfigFormProps) {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial?.port ?? 22)
  const [username, setUsername] = useState(initial?.username || 'root')
  const [authType, setAuthType] = useState<SSHAuthType>(initial?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [defaultPath, setDefaultPath] = useState(initial?.defaultPath ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleBrowseKey = async () => {
    const result = await window.api.selectFile()
    if (result.success && result.data) {
      setPrivateKeyPath(result.data)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedHost = host.trim()
    const resolvedLabel = label.trim() || trimmedHost
    const resolvedUsername = username.trim()

    if (!trimmedHost) {
      setError('请填写主机')
      return
    }
    if (!resolvedUsername) {
      setError('请填写用户名')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave({
        id: initial?.id,
        label: resolvedLabel,
        host: trimmedHost,
        port,
        username: resolvedUsername,
        authType,
        defaultPath: defaultPath || undefined,
        password: authType === 'password' ? password : undefined,
        privateKeyPath: authType === 'privateKey' ? privateKeyPath : undefined,
        passphrase: authType === 'privateKey' ? passphrase || undefined : undefined,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="标签">
          <Input value={label} placeholder="My Server" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="主机" error={error === '请填写主机' ? error : undefined}>
          <Input value={host} placeholder="192.168.1.100" onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label="端口">
          <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </Field>
        <Field label="用户名" error={error === '请填写用户名' ? error : undefined}>
          <Input value={username} placeholder="root" onChange={(e) => setUsername(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">认证方式</span>
        <RadioGroup
          name="ssh-auth-type"
          aria-label="认证方式"
          variant="segmented"
          value={authType}
          onValueChange={setAuthType}
          options={AUTH_TYPES}
          className="w-fit"
        />
      </div>

      {authType === 'password' && (
        <Field label="密码">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}

      {authType === 'privateKey' && (
        <>
          <Field label="私钥路径">
            <div className="flex gap-2">
              <Input
                mono
                value={privateKeyPath}
                placeholder="~/.ssh/id_rsa"
                wrapperClassName="min-w-0 flex-1"
                onChange={(e) => setPrivateKeyPath(e.target.value)}
              />
              <Button icon={Folder} onClick={() => void handleBrowseKey()}>浏览</Button>
            </div>
          </Field>
          <Field label="密钥密码（可选）">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
        </>
      )}

      <Field label="默认路径（可选）">
        <Input value={defaultPath} placeholder="/home/user" onChange={(e) => setDefaultPath(e.target.value)} />
      </Field>

      {error && error !== '请填写主机' && error !== '请填写用户名' && (
        <Panel variant="bordered" role="alert" className="border-danger/40 bg-danger-quiet p-2 text-sm text-danger-text">
          {error}
        </Panel>
      )}

      <div className="flex gap-2 pt-1">
        <Button type="submit" variant="primary" icon={Check} loading={saving} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </form>
  )
}
