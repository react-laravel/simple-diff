import { useUIStore } from '../../stores/ui-store'
import { ConfirmDialog } from '../ui'

export default function SyncConfirmDialog() {
  const pending = useUIStore((state) => state.pendingSync)
  const finish = (proceed: boolean) => {
    useUIStore.getState().setPendingSync(null)
    pending?.resolve(proceed)
  }
  if (!pending) return null
  const { request, preview, resume } = pending
  const toRight = request.direction === 'left_to_right'
  const from = toRight ? request.leftSource : request.rightSource
  const to = toRight ? request.rightSource : request.leftSource
  return <ConfirmDialog open onOpenChange={(open) => { if (!open) finish(false) }}
    title={resume ? '确认继续同步' : toRight ? '确认同步到右侧' : '确认同步到左侧'}
    body={<span>{resume ? '剩余范围' : '本次范围'}：{preview.files} 个文件、{preview.directories} 个目录。会覆盖 {preview.overwrites} 个文件。</span>}
    subject={`${from.type === 'sftp' ? 'SFTP ' : ''}${from.path}\n→ ${to.type === 'sftp' ? 'SFTP ' : ''}${to.path}`}
    consequence="已展开目录并检查目标。目标侧额外文件会保留；目标内容发生变化时会停止覆盖，需重新对比。"
    confirmLabel={resume ? '确认并继续' : '确认并同步'} onConfirm={() => finish(true)} />
}
