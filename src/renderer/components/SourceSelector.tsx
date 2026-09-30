import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DirectoryDragDropEvent } from '../../../shared/app-api'
import type { SSHConfig } from '../../../shared/types'
import { useSSHStore } from '../stores/ssh-store'
import { useUIStore } from '../stores/ui-store'
import { getRuntimeInfo } from '../runtime/runtime-info'
import { Button, Input, Select, ToggleGroup, type ToggleGroupOption } from './ui'
import SFTPBrowserDialog from './overlays/SFTPBrowserDialog'
import { cn } from '../lib/utils'
import { Folder, Server } from 'lucide-react'
import { findFolderDropTarget, getDroppedFolderPath } from '../utils/folder-drop'
import { isSubmitKey } from '../utils/submit-key'

type SourceType = 'local' | 'sftp'

interface SourceSelectorProps {
  readonly label: string
  readonly sourceType: SourceType
  readonly path: string
  readonly sshConfigId: string
  readonly onSourceTypeChange: (type: SourceType) => void
  readonly onPathChange: (path: string) => void
  readonly onSSHConfigIdChange: (id: string) => void
  /** 蓝图 §4.2：在路径框里按 Enter 等同于按下面板的主按钮。 */
  readonly onSubmit?: () => void
}

function applyLocalFolderPath(
  path: string,
  sourceType: SourceType,
  onSourceTypeChange: (type: SourceType) => void,
  onSSHConfigIdChange: (id: string) => void,
  onPathChange: (path: string) => void,
): void {
  if (sourceType !== 'local') {
    onSourceTypeChange('local')
    onSSHConfigIdChange('')
  }
  onPathChange(path)
}

/**
 * 数据源一行：类型（本地 / SFTP）· 连接 · 路径 · 浏览。
 *
 * chunk 8 第 6 条改了两处外壳，交互一字未动：
 * - 内嵌的手写远程目录模态框搬到 `overlays/SFTPBrowserDialog.tsx`（`Dialog`，带焦点
 *   陷阱与焦点归还），这个组件只剩「开 / 关 + 拿回选中的路径」。
 * - SFTP 连接下拉旁多了一个「管理连接…」，这是 `SSHManagerDialog` 的第一入口
 *   （另外两个是应用菜单和 `⌘K`）——SSH 管理唯一的消费者本来就是这里（§2.3）。
 */
export default function SourceSelector({
  label,
  sourceType,
  path,
  sshConfigId,
  onSourceTypeChange,
  onPathChange,
  onSSHConfigIdChange,
  onSubmit,
}: SourceSelectorProps) {
  const runtime = getRuntimeInfo()
  const openOverlay = useUIStore((state) => state.openOverlay)
  const { configs, loadConfigs } = useSSHStore(useShallow((state) => ({
    configs: state.configs,
    loadConfigs: state.loadConfigs,
  })))
  const [isDragOver, setIsDragOver] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const dragDepthRef = useRef(0)
  const dropTargetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadConfigs()
  }, [loadConfigs])

  useEffect(() => {
    if (runtime.supportsSftp || sourceType !== 'sftp') {
      return
    }

    onSourceTypeChange('local')
    onSSHConfigIdChange('')
  }, [onSSHConfigIdChange, onSourceTypeChange, runtime.supportsSftp, sourceType])

  // 换来源类型 / 换连接都要关掉正在开着的远程浏览器，它拿的是旧连接。
  useEffect(() => {
    setBrowserOpen(false)
  }, [sourceType, sshConfigId])

  useEffect(() => {
    if (typeof window.api.onDirectoryDragDrop !== 'function') return

    const handleNativeDrop = (event: DirectoryDragDropEvent) => {
      const target = dropTargetRef.current
      if (!target) return
      if (event.type === 'leave') {
        setIsDragOver(false)
        return
      }

      const hit = findFolderDropTarget({ x: event.x, y: event.y }) === target
      if (event.type === 'over') {
        setIsDragOver(hit)
        return
      }

      setIsDragOver(false)
      if (!hit || event.paths.length === 0) return
      applyLocalFolderPath(
        event.paths[0],
        sourceType,
        onSourceTypeChange,
        onSSHConfigIdChange,
        onPathChange,
      )
    }

    return window.api.onDirectoryDragDrop(handleNativeDrop)
  }, [onPathChange, onSSHConfigIdChange, onSourceTypeChange, sourceType])

  const handleBrowseLocal = async () => {
    const result = await window.api.selectFolder()
    if (result.success && result.data) {
      onPathChange(result.data)
    }
  }

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragOver(true)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragOver(false)
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    // Tauri 的 Finder 拖放由 onDirectoryDragDrop 负责；HTML5 File 没有真实路径。
    if (runtime.supportsDirectoryDragDrop) return

    const droppedPath = getDroppedFolderPath(event, (file) => window.api.getPathForFile(file))
    if (droppedPath) {
      applyLocalFolderPath(
        droppedPath,
        sourceType,
        onSourceTypeChange,
        onSSHConfigIdChange,
        onPathChange,
      )
    }
  }

  const typeOptions: ToggleGroupOption<SourceType>[] = [
    { value: 'local', label: '本地', icon: Folder },
    {
      value: 'sftp',
      label: 'SFTP',
      icon: Server,
      disabled: !runtime.supportsSftp,
      title: runtime.supportsSftp ? undefined : '当前版本暂不支持 SFTP',
    },
  ]

  const activeConfig = configs.find((config: SSHConfig) => config.id === sshConfigId)

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium tracking-wider text-fg-muted uppercase">{label}</label>
      <div
        ref={dropTargetRef}
        data-folder-drop=""
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md p-0.5 transition-colors',
          isDragOver && 'bg-accent-quiet ring-2 ring-dashed ring-accent/40',
        )}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ToggleGroup
          aria-label={`${label}数据源类型`}
          variant="segmented"
          size="sm"
          value={sourceType}
          onValueChange={onSourceTypeChange}
          options={typeOptions}
        />

        {sourceType === 'sftp' ? (
          <>
            <Select
              size="sm"
              aria-label={`${label} SFTP 连接`}
              value={sshConfigId}
              onChange={(event) => {
                onSSHConfigIdChange(event.target.value)
                const config = configs.find((item: SSHConfig) => item.id === event.target.value)
                if (config?.defaultPath) {
                  onPathChange(config.defaultPath)
                }
              }}
              options={configs.map((config: SSHConfig) => ({
                value: config.id,
                label: `${config.label} (${config.host})`,
              }))}
              placeholder="选择连接..."
            />
            <Button variant="link" size="sm" onClick={() => openOverlay('ssh')}>
              管理连接…
            </Button>
          </>
        ) : null}

        <Input
          size="sm"
          mono
          type="text"
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          onKeyDown={(event) => {
            if (!onSubmit || !isSubmitKey(event.nativeEvent)) return
            event.preventDefault()
            onSubmit?.()
          }}
          placeholder={sourceType === 'local' ? '选择或拖入目录路径...' : '远程目录路径...'}
          aria-label={`${label}路径`}
          wrapperClassName="min-w-0 flex-1 basis-48"
          className={cn(isDragOver && 'border-accent')}
        />

        {sourceType === 'local' ? (
          <Button size="sm" icon={Folder} onClick={() => void handleBrowseLocal()}>
            浏览...
          </Button>
        ) : (
          <Button size="sm" icon={Server} disabled={!sshConfigId} onClick={() => setBrowserOpen(true)}>
            浏览...
          </Button>
        )}
      </div>

      {isDragOver ? (
        <p className="text-xs text-fg-muted">松开以使用拖入的目录路径。</p>
      ) : null}

      {sourceType === 'sftp' ? (
        <SFTPBrowserDialog
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          sshConfigId={sshConfigId}
          initialPath={path || activeConfig?.defaultPath || '/'}
          onSelect={onPathChange}
          sideLabel={label}
        />
      ) : null}
    </div>
  )
}
