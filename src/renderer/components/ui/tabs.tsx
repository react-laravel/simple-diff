import { X, type LucideIcon } from 'lucide-react'
import { useRef } from 'react'
import { cn } from '../../lib/utils'
import { useRovingTabIndex } from './_internal/hooks'
import { StatusDot } from './badge'
import { ContextMenu } from './menu'
import type { MenuItem } from './types'

export interface TabItem {
  value: string
  id?: string
  controls?: string
  label: React.ReactNode
  icon?: LucideIcon
  badge?: React.ReactNode
  disabled?: boolean
}

export interface TabsProps {
  value: string
  onValueChange: (v: string) => void
  items: TabItem[]
  variant?: 'underline' | 'pill'
  size?: 'sm' | 'md'
  className?: string
  'aria-label': string
}

/** Full `tablist` / `tab` ARIA plus roving tabIndex. */
export function Tabs({
  value,
  onValueChange,
  items,
  variant = 'underline',
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: TabsProps) {
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  )
  const { focusIndex, setFocusIndex, move } = useRovingTabIndex(items.length, activeIndex)
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const focusAt = (index: number) => {
    setFocusIndex(index)
    refs.current[index]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = (delta: number) => {
      event.preventDefault()
      const next = (focusIndex + delta + items.length) % items.length
      focusAt(next)
    }
    if (event.key === 'ArrowRight') step(1)
    else if (event.key === 'ArrowLeft') step(-1)
    else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    } else {
      move(0)
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'flex items-center',
        variant === 'underline' ? 'gap-3 border-b border-border' : 'gap-0.5 rounded-md bg-surface-2 p-0.5',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="tab"
            id={item.id}
            aria-controls={item.controls}
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap transition-colors duration-[180ms]',
              size === 'sm' ? 'h-control-sm text-xs' : 'h-control-md text-sm',
              'disabled:pointer-events-none disabled:opacity-50',
              variant === 'underline'
                ? cn(
                    '-mb-px border-b-2 px-0.5 font-medium',
                    selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )
                : cn(
                    'rounded-sm px-2 font-medium',
                    selected ? 'bg-surface text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                  ),
            )}
          >
            {Icon ? <Icon aria-hidden size={14} strokeWidth={1.75} /> : null}
            {item.label}
            {item.badge}
          </button>
        )
      })}
    </div>
  )
}

export interface DocumentTab {
  id: string
  title: string
  /** Full label for the truncated title — `title` attribute on the tab. */
  tooltip?: string
  icon?: LucideIcon
  dirty?: boolean
  status?: 'running' | 'error' | null
  closable?: boolean
}

export interface TabStripProps {
  tabs: DocumentTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onContextMenu?: (id: string) => MenuItem[]
  leading?: React.ReactNode
  trailing?: React.ReactNode
  className?: string
  'aria-label': string
}

/**
 * Closable document tabs. Always exposes the same affordances regardless of who
 * mounts it — that is what fixes the drift where the same strip silently loses
 * its close buttons on one screen.
 */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  leading,
  trailing,
  className,
  'aria-label': ariaLabel,
}: TabStripProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex h-tabstrip shrink-0 items-center gap-1 border-b border-border bg-surface px-1', className)}
    >
      {leading}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId
          const Icon = tab.icon
          const closable = tab.closable !== false && Boolean(onClose)
          const button = (
            <div
              key={tab.id}
              className={cn(
                'group flex h-control-sm min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5',
                active ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={tab.tooltip}
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 items-center gap-1.5 text-xs"
              >
                {tab.status ? (
                  <StatusDot status={tab.status === 'error' ? 'danger' : 'running'} />
                ) : Icon ? (
                  <Icon aria-hidden size={12} strokeWidth={1.75} />
                ) : null}
                <span className="max-w-40 truncate">{tab.title}</span>
                {tab.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="未保存" /> : null}
              </button>
              {closable ? (
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose?.(tab.id)
                  }}
                  className="rounded-xs p-0.5 text-fg-subtle hover:bg-hover hover:text-fg"
                >
                  <X aria-hidden size={12} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          )

          if (!onContextMenu) return button
          return (
            <ContextMenu key={tab.id} items={() => onContextMenu(tab.id)}>
              {button}
            </ContextMenu>
          )
        })}
      </div>
      {trailing}
    </div>
  )
}

export interface ToggleGroupOption<T extends string> {
  value: T
  label: React.ReactNode
  icon?: LucideIcon
  count?: number
  disabled?: boolean
  title?: string
  /**
   * Keeps the accessible name stable when `count` is a live-updating number —
   * a filter chip must not be renamed on every streamed row.
   */
  ariaLabel?: string
}

export interface ToggleGroupProps<T extends string> {
  value: T
  onValueChange: (v: T) => void
  options: ToggleGroupOption<T>[]
  variant?: 'segmented' | 'chips'
  size?: 'xs' | 'sm'
  className?: string
  'aria-label': string
}

/** Mutually exclusive view modes (`segmented`) or filter chips with counts (`chips`). */
export function ToggleGroup<T extends string>({
  value,
  onValueChange,
  options,
  variant = 'segmented',
  size = 'sm',
  className,
  'aria-label': ariaLabel,
}: ToggleGroupProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center',
        variant === 'segmented' ? 'gap-0.5 rounded-md border border-border bg-surface-2 p-0.5' : 'flex-wrap gap-1',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1 font-medium whitespace-nowrap transition-colors duration-[120ms]',
              'disabled:pointer-events-none disabled:opacity-50',
              size === 'xs' ? 'h-control-xs px-1.5 text-2xs' : 'h-control-sm px-2 text-xs',
              variant === 'segmented'
                ? cn('rounded-sm', selected ? 'bg-surface text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg')
                : cn(
                    'rounded-md border',
                    selected
                      ? 'border-accent/40 bg-accent-quiet text-accent-text'
                      : 'border-border bg-surface text-fg-muted hover:bg-hover hover:text-fg',
                  ),
            )}
          >
            {Icon ? <Icon aria-hidden size={size === 'xs' ? 12 : 14} strokeWidth={1.75} /> : null}
            {option.label}
            {typeof option.count === 'number' ? (
              <span className="tabular-nums opacity-70">{option.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
