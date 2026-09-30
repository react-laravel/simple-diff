import { Dialog, type DialogProps } from './ui'

interface ManagementSurfaceProps extends DialogProps {
  readonly variant?: 'dialog' | 'page'
}

/** Reuse management workflows in a full tab and in contextual dialogs. */
export default function ManagementSurface({ variant = 'dialog', ...props }: ManagementSurfaceProps) {
  if (variant === 'dialog') return <Dialog {...props} />
  if (!props.open) return null

  const { title, description, footer, children } = props
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-fg">{title}</h1>
          {description ? <p className="mt-1 text-xs text-fg-muted">{description}</p> : null}
        </div>
        {footer ? <div className="flex items-center gap-2">{footer}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-6xl">{children}</div>
      </div>
    </section>
  )
}
