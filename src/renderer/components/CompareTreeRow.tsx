import { memo } from 'react'
import { Check, File, Folder, Link2, Loader2, X } from 'lucide-react'
import type { TreeNode } from '../utils/tree-utils'
import StatusBadge from './StatusBadge'
import {
  diffKindForState,
  formatSize,
  formatTime,
  rowBg,
  shouldShowDirectorySpinner,
} from './tree-row-utils'
import { DiffGutter, IconButton, TreeRow, type MenuItem } from './ui'
import { cn } from '../lib/utils'

export type CompareRowSide = 'left' | 'right' | 'merged'

export interface CompareTreeRowProps {
  readonly node: TreeNode
  /** `left` / `right` 只画自己那一侧的大小与时间；`merged` 两侧都画。 */
  readonly side: CompareRowSide
  readonly index: number
  readonly setSize: number
  readonly expanded: boolean
  readonly loading: boolean
  readonly dirty: boolean
  readonly selected: boolean
  readonly focused: boolean
  readonly onSelect: (event: React.MouseEvent) => void
  readonly onToggle: () => void
  readonly onActivate: () => void
  /**
   * 右键菜单与常驻 `⋯` 用同一份动作（DESIGN-SYSTEM §5：悬停不得是唯一入口）。
   * 传函数而不是数组，是为了让 `memo` 能按引用比较——数组每次渲染都是新的。
   */
  readonly buildActions: (node: TreeNode) => MenuItem[]
  readonly renaming?: boolean
  readonly renameValue?: string
  readonly onRenameChange?: (value: string) => void
  readonly onRenameSubmit?: () => void
  readonly onRenameCancel?: () => void
}

/** 数值列的固定宽度，行与表头共用，保证虚拟滚动时列不会跳。 */
export const SIZE_COLUMN = 'w-16 tree-size-column'
export const TIME_COLUMN = 'w-28 tree-time-column'
export const STATUS_COLUMN = 'w-14'
/** 列间距，行与表头共用。 */
export const META_GAP = 'gap-2'

function MetaCell({ className, children }: { readonly className: string; readonly children: React.ReactNode }) {
  return (
    <span className={cn('shrink-0 truncate text-right text-2xs text-fg-muted tabular-nums', className)}>
      {children}
    </span>
  )
}

function fileMeta(file: { readonly size: number; readonly mtime: number } | undefined, isDirectory: boolean) {
  if (!file) return { size: '', time: '' }
  if (isDirectory) return { size: '—', time: '—' }
  return { size: formatSize(file.size), time: formatTime(file.mtime) }
}

function CompareTreeRowImpl({
  node,
  side,
  index,
  setSize,
  expanded,
  loading,
  dirty,
  selected,
  focused,
  onSelect,
  onToggle,
  onActivate,
  buildActions,
  renaming = false,
  renameValue = '',
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: CompareTreeRowProps) {
  const entry = node.entry
  if (!entry) return null

  // 分栏视图的核心信息就是“这一侧没有”。两栏行数必须一一对应（滚动是同步的），
  // 所以留一行占位的空行，而不是把这一行整个抽掉。
  const missingOnSide = side === 'left' ? !entry.left : side === 'right' ? !entry.right : false
  if (missingOnSide) {
    return (
      <TreeRow
        data-tree-index={index}
        depth={node.depth}
        setSize={setSize}
        posInSet={index + 1}
        label={<span className="font-mono text-xs text-fg-subtle">—</span>}
        aria-label={`${node.name}，${side === 'left' ? '左侧不存在，仅在右侧' : '右侧不存在，仅在左侧'}`}
        selected={selected}
        focused={focused}
        onSelect={onSelect}
        onActivate={onActivate}
        className="border-b border-border bg-inset/40"
      />
    )
  }

  const isSymlink = side === 'left' ? entry.left?.isSymlink : side === 'right' ? entry.right?.isSymlink : entry.left?.isSymlink || entry.right?.isSymlink
  const linkDescription = side === 'merged'
    ? [entry.left?.isSymlink ? '左侧符号链接' : '', entry.right?.isSymlink ? '右侧符号链接' : ''].filter(Boolean).join('，')
    : isSymlink ? '符号链接' : ''
  const typeNames = { file: '文件', directory: '目录', symlink: '符号链接' }
  const typeReason = entry.reasons.find((reason) => reason.type === 'type')
  const typeDescription = typeReason?.type === 'type' ? `类型不同：左侧${typeNames[typeReason.leftType]}，右侧${typeNames[typeReason.rightType]}` : ''
  const rowDescription = [node.name, linkDescription, typeDescription].filter(Boolean).join('，')
  const showSpinner = shouldShowDirectorySpinner(entry.isDirectory, loading, entry.state)
  const left = fileMeta(entry.left, entry.isDirectory)
  const right = fileMeta(entry.right, entry.isDirectory)
  const menuItems = buildActions(node)

  const label = renaming ? (
    <span className="flex min-w-0 items-center gap-1" onKeyDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <input
        type="text"
        aria-label={`重命名 ${node.name}`}
        value={renameValue}
        autoFocus
        spellCheck={false}
        onChange={(event) => onRenameChange?.(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); onRenameSubmit?.() }
          if (event.key === 'Escape') { event.preventDefault(); onRenameCancel?.() }
        }}
        data-focus-inset
        className="w-full min-w-0 flex-1 rounded-xs border border-border-strong bg-canvas px-1 font-mono text-xs text-fg focus:border-accent"
      />
      <IconButton size="xs" icon={Check} label={`确认重命名 ${node.name}`} onClick={(event) => { event.stopPropagation(); onRenameSubmit?.() }} />
      <IconButton size="xs" icon={X} label={`取消重命名 ${node.name}`} onClick={(event) => { event.stopPropagation(); onRenameCancel?.() }} />
    </span>
  ) : (
    <span title={[node.relativePath, linkDescription, typeDescription].filter(Boolean).join(' · ')} className="truncate font-mono text-xs">{node.name}{isSymlink ? <span className="ml-1 text-fg-subtle">（链接）</span> : null}</span>
  )

  return (
    <TreeRow
      data-tree-index={index}
      aria-label={linkDescription || typeDescription ? rowDescription : undefined}
      title={typeDescription || undefined}
      depth={node.depth}
      setSize={setSize}
      posInSet={index + 1}
      label={label}
      icon={showSpinner ? Loader2 : isSymlink ? Link2 : node.isDirectory ? Folder : File}
      iconTone={showSpinner ? 'running' : node.isDirectory ? 'accent' : 'neutral'}
      expandable={node.isDirectory && !isSymlink}
      expanded={expanded}
      onToggle={onToggle}
      selected={selected}
      focused={focused}
      onSelect={onSelect}
      onActivate={onActivate}
      onDoubleClick={onActivate}
      onContextMenu={menuItems.length > 0 ? () => menuItems : undefined}
      overflow={menuItems.length > 0 ? menuItems : undefined}
      className={cn(
        'border-b border-border',
        showSpinner && '[&_svg]:animate-spin-slow',
        !selected && !entry.isDirectory && rowBg(entry.state),
      )}
      leading={<DiffGutter kind={diffKindForState(entry.state)} />}
      meta={
        // `TreeRow` 把 `meta` 放进一个行内 `<span>`；这里必须自己开一个 flex 容器，
        // 否则 `MetaCell` 上的固定宽度对行内元素无效，虚拟滚动时列会左右跳。
        <span className={cn('flex items-center', META_GAP)}>
          {side === 'merged' ? <>
            <MetaCell className={SIZE_COLUMN}>{left.size}</MetaCell>
            <MetaCell className={TIME_COLUMN}>{left.time}</MetaCell>
            <span className={cn('flex shrink-0 justify-center', STATUS_COLUMN)}><StatusBadge state={entry.state} dirty={dirty} /></span>
            <MetaCell className={SIZE_COLUMN}>{right.size}</MetaCell>
            <MetaCell className={TIME_COLUMN}>{right.time}</MetaCell>
          </> : <>
            <MetaCell className={SIZE_COLUMN}>{side === 'left' ? left.size : right.size}</MetaCell>
            <MetaCell className={TIME_COLUMN}>{side === 'left' ? left.time : right.time}</MetaCell>
            <span className={cn('flex shrink-0 justify-center', STATUS_COLUMN)}><StatusBadge state={entry.state} dirty={dirty} /></span>
          </>}
        </span>
      }
    />
  )
}

/**
 * 分栏视图与合并视图共用的行渲染器，建在共享 `TreeRow` 之上（chunk 7 第 1 条）。
 * 以前是两份：`TreeRow.tsx`（6 列表格行）与 `SplitTree` 里的 `SideRow`（4 列），
 * 各自复制缩进、展开箭头、选中态和右键菜单。
 */
const CompareTreeRow = memo(CompareTreeRowImpl, (prev, next) => {
  if (prev.side !== next.side) return false
  if (prev.index !== next.index) return false
  if (prev.setSize !== next.setSize) return false
  if (prev.selected !== next.selected) return false
  if (prev.focused !== next.focused) return false
  if (prev.expanded !== next.expanded) return false
  if (prev.loading !== next.loading) return false
  if (prev.dirty !== next.dirty) return false
  if (prev.renaming !== next.renaming) return false
  if (prev.renaming && prev.renameValue !== next.renameValue) return false
  if (prev.node.relativePath !== next.node.relativePath) return false
  if (prev.node.entry !== next.node.entry) return false
  if (prev.buildActions !== next.buildActions) return false
  return true
})

export default CompareTreeRow
