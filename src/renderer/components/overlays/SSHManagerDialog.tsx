import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CirclePlus, Server } from 'lucide-react'
import type { SSHConfig, SSHConfigInput } from '../../../../shared/types'
import { Badge, Button, ConfirmDialog, EmptyState, Panel, Skeleton } from '../ui'
import ManagementSurface from '../ManagementSurface'
import SSHConfigForm from '../SSHConfigForm'
import { useSSHStore } from '../../stores/ssh-store'
import { showToast } from '../../stores/toast-store'

export interface SSHManagerDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly variant?: 'dialog' | 'page'
}

interface TestResult {
  readonly id: string
  readonly ok: boolean
  readonly message: string
}

/**
 * 蓝图 §2.3 / chunk 8 第 3 条：SSH 管理唯一的消费者是 SFTP 数据源选择器
 * （`SourceSelector`），所以它从顶层导航槽位降级成一个 `Dialog`，三个入口：
 * SFTP 连接下拉旁的「管理连接…」、应用菜单、`⌘K`。
 *
 * `SSHConfigForm` 原样复用，只有外层容器换成了共享原语。
 */
// 顶栏页签与数据源旁的上下文对话框复用同一份配置和操作。
export default function SSHManagerDialog({ open, onOpenChange, variant = 'dialog' }: SSHManagerDialogProps) {
  const { configs, loading, loadConfigs } = useSSHStore(useShallow((state) => ({
    configs: state.configs,
    loading: state.loading,
    loadConfigs: state.loadConfigs,
  })))
  const [editing, setEditing] = useState<SSHConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SSHConfig | null>(null)

  useEffect(() => {
    if (!open) return
    void loadConfigs()
  }, [loadConfigs, open])

  // 关闭后重开不应该还停在上一次的编辑表单上。
  useEffect(() => {
    if (open) return
    setEditing(null)
    setCreating(false)
    setTestResult(null)
    setPendingDelete(null)
  }, [open])

  const handleSave = useCallback(async (input: SSHConfigInput) => {
    const result = await window.api.saveSSHConfig(input)
    if (!result.success) {
      throw new Error(result.error ?? '保存失败')
    }
    setEditing(null)
    setCreating(false)
    await loadConfigs()
    showToast({
      tone: 'success',
      message: input.id ? '连接已更新' : '已保存连接',
      description: input.label || input.host,
    })
  }, [loadConfigs])

  const handleDelete = useCallback(async (config: SSHConfig) => {
    const result = await window.api.deleteSSHConfig(config.id)
    if (result.success) {
      await loadConfigs()
      showToast({ tone: 'info', message: '已删除连接', description: config.label ?? config.id })
    } else {
      showToast({ tone: 'error', message: '删除失败', description: result.error ?? '未知错误' })
    }
    setPendingDelete(null)
  }, [loadConfigs])

  const handleTest = useCallback(async (config: SSHConfig) => {
    setTesting(config.id)
    setTestResult(null)
    const result = await window.api.testSSHConnection(config.id)
    setTesting(null)
    const ok = result.success && result.data === true
    setTestResult({ id: config.id, ok, message: ok ? '连接成功' : (result.error ?? '连接失败') })
    showToast({
      tone: ok ? 'success' : 'error',
      message: ok ? '连接成功' : '连接失败',
      description: config.label ?? config.host,
    })
  }, [])

  const editorOpen = creating || editing !== null

  return (
    <>
      <ManagementSurface
        variant={variant}
        open={open}
        onOpenChange={onOpenChange}
        title="SSH 连接管理"
        description={
          loading
            ? '正在加载…'
            : configs.length === 0
              ? '尚未配置 SSH 连接'
              : `共 ${configs.length} 个连接配置`
        }
        size="lg"
        footer={
          <>
            {!editorOpen ? (
              <Button variant="primary" icon={CirclePlus} onClick={() => setCreating(true)}>
                新建连接
              </Button>
            ) : null}
            {variant === 'dialog' ? <Button variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button> : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {editorOpen ? (
            <Panel header={editing ? `编辑：${editing.label}` : '新建 SSH 连接'}>
              <SSHConfigForm
                initial={editing ?? undefined}
                onSave={handleSave}
                onCancel={() => {
                  setEditing(null)
                  setCreating(false)
                }}
              />
            </Panel>
          ) : null}

          {loading ? <Skeleton variant="row" count={3} /> : null}

          {!loading && configs.length === 0 && !creating ? (
            <EmptyState
              variant="first-run"
              icon={Server}
              title="暂无 SSH 连接"
              description="添加一个连接后，数据源就能选 SFTP 目录。"
              action={
                <Button variant="primary" icon={CirclePlus} onClick={() => setCreating(true)}>
                  新建连接
                </Button>
              }
              size="sm"
            />
          ) : null}

          <ul className="flex flex-col gap-2">
            {configs.map((config) => (
              <li
                key={config.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-accent-text">
                  <Server aria-hidden size={14} strokeWidth={1.75} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{config.label}</span>
                    <Badge tone="neutral" size="xs">
                      {config.authType === 'password' ? '密码' : 'SSH Key'}
                    </Badge>
                    {testResult?.id === config.id ? (
                      <Badge tone={testResult.ok ? 'success' : 'danger'} size="xs">
                        {testResult.message}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-xs text-fg-muted">
                    <span>{config.username}@{config.host}:{config.port}</span>
                    {config.defaultPath ? (
                      <span className="truncate text-fg-subtle" title={config.defaultPath}>
                        默认路径 · {config.defaultPath}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={testing === config.id}
                    disabled={testing === config.id}
                    onClick={() => void handleTest(config)}
                  >
                    {testing === config.id ? '测试中…' : '测试'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setCreating(false)
                      setEditing(config)
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    aria-label={`删除 ${config.label}`}
                    onClick={() => setPendingDelete(config)}
                  >
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </ManagementSurface>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        tone="danger"
        title="删除这个 SSH 连接？"
        subject={pendingDelete ? `${pendingDelete.username}@${pendingDelete.host}:${pendingDelete.port}` : undefined}
        consequence="使用该连接的对比标签需要重新选择数据源。"
        confirmLabel="删除"
        onConfirm={() => {
          if (pendingDelete) return handleDelete(pendingDelete)
        }}
      />
    </>
  )
}
