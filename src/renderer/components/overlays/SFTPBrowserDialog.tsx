import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Folder, RefreshCw, ServerOff } from 'lucide-react'
import { joinSourcePath, normalizeRemoteBrowserPath } from '@shared/source-path'
import type { FileEntry } from '../../../../shared/types'
import { Button, Dialog, EmptyState, Panel, Skeleton } from '../ui'

export { normalizeRemoteBrowserPath } from '@shared/source-path'

export function getRemoteParentPath(path: string): string {
  const normalizedPath = normalizeRemoteBrowserPath(path)
  if (normalizedPath === '/') {
    return '/'
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  if (segments.length <= 1) {
    return '/'
  }

  return `/${segments.slice(0, -1).join('/')}`
}

export interface SFTPBrowserDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly sshConfigId: string
  /** 打开时的落脚目录：当前路径 → 连接默认路径 → `/`。 */
  readonly initialPath: string
  readonly onSelect: (path: string) => void
  /** 用于可访问名字，例如「左侧」。 */
  readonly sideLabel: string
}

/**
 * 蓝图 §6 / chunk 8 第 6 条：`SourceSelector.tsx:325-431` 那个手写模态框换成 `Dialog`。
 *
 * 旧实现自己写了遮罩、`stopPropagation`、一个 Esc 监听和一个关闭按钮——即
 * `Modal.tsx` 已经做过一遍的事，而且没有焦点陷阱、没有焦点归还。行为逐字保留：
 * 上一级 / 刷新 / 进入子目录 / 选择当前目录。
 */
export default function SFTPBrowserDialog({
  open,
  onOpenChange,
  sshConfigId,
  initialPath,
  onSelect,
  sideLabel,
}: SFTPBrowserDialogProps) {
  const [path, setPath] = useState('/')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [confirmedPath, setConfirmedPath] = useState<string | null>(null)
  const [directories, setDirectories] = useState<readonly FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const loadDirectories = useCallback(async (nextPath: string) => {
    if (!sshConfigId) return
    const requestId = ++requestIdRef.current
    setPath(nextPath)
    setConfirmedPath(null)
    setDirectories([])
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.browseSSH(sshConfigId, nextPath)
      if (requestIdRef.current !== requestId) return
      if (result.success && result.data) {
        setPath(result.data.path)
        setConfirmedPath(result.data.path)
        setRootPath(result.data.rootPath)
        setDirectories(
          result.data.entries
            .filter((entry) => entry.isDirectory && !entry.isSymlink)
            .slice()
            .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
        )
      } else {
        setError(result.error ?? '远程目录读取失败')
      }
    } catch (cause) {
      if (requestIdRef.current !== requestId) return
      setError(cause instanceof Error ? cause.message : '远程目录读取失败')
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [sshConfigId])

  const navigate = useCallback((nextPath: string) => {
    const normalized = normalizeRemoteBrowserPath(nextPath)
    void loadDirectories(normalized)
  }, [loadDirectories])

  // 只在「关 → 开」那一刻定位一次；之后 `path` 归用户的导航管，`initialPath` 再变
  // （对话框是模态的，实际上不会）也不会把用户拽回起点。
  const openedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      openedRef.current = null
      ++requestIdRef.current
      return
    }
    if (openedRef.current === sshConfigId) return
    openedRef.current = sshConfigId

    const normalized = initialPath.startsWith('/') ? normalizeRemoteBrowserPath(initialPath) : initialPath.trim() || '/'
    setRootPath(null)
    void loadDirectories(normalized)
  }, [initialPath, loadDirectories, open, sshConfigId])

  useEffect(() => () => { ++requestIdRef.current; openedRef.current = null }, [])
  const canGoUp = rootPath !== null && path !== rootPath && path !== '/'

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="浏览远程目录"
      description={`${sideLabel} · ${path}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="primary"
            icon={Check}
            disabled={loading || error !== null || confirmedPath === null}
            onClick={() => {
              if (!confirmedPath || loading || error) return
              onSelect(confirmedPath)
              onOpenChange(false)
            }}
          >
            选择当前目录
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            icon={ArrowLeft}
            disabled={loading || !canGoUp}
            onClick={() => navigate(getRemoteParentPath(path))}
          >
            上一级
          </Button>
          <Button
            size="sm"
            icon={RefreshCw}
            loading={loading}
            disabled={loading}
            onClick={() => void loadDirectories(path)}
          >
            刷新
          </Button>
          <span className="ml-auto min-w-0 truncate font-mono text-xs text-fg-muted" title={path}>
            {path}
          </span>
        </div>

        {loading ? <Skeleton variant="row" count={6} /> : null}

        {!loading && error ? (
          <EmptyState
            variant="error"
            icon={ServerOff}
            title="无法读取远程目录"
            description={error}
            error={error}
            action={<Button variant="primary" icon={RefreshCw} onClick={() => void loadDirectories(path)}>重试</Button>}
            secondaryAction={
              !canGoUp ? undefined : (
                <Button variant="ghost" icon={ArrowLeft} onClick={() => navigate(getRemoteParentPath(path))}>
                  返回上一级
                </Button>
              )
            }
            size="sm"
          />
        ) : null}

        {!loading && !error ? (
          <Panel padded={false}>
            {directories.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-fg-muted">当前目录下没有可浏览的子目录</p>
            ) : (
              <ul>
                {directories.map((entry) => (
                  <li key={entry.path} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      data-focus-inset
                      onClick={() => navigate(joinSourcePath('sftp', path, entry.name))}
                      className="group flex h-row-table w-full items-center justify-between gap-2 px-3 text-left text-sm text-fg transition-colors hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Folder aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-accent-text" />
                        <span className="truncate font-mono text-xs">{entry.name}/</span>
                      </span>
                      <span className="shrink-0 text-2xs text-fg-subtle group-hover:text-fg">进入</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}
      </div>
    </Dialog>
  )
}
