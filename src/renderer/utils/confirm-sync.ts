import type { StartSyncRequest, SyncPlanPreview, SyncTaskSnapshot } from '../../../shared/types'
import { useUIStore } from '../stores/ui-store'
import { reportSyncResult } from './sync-feedback'
import { showToast, useToastStore } from '../stores/toast-store'

let preparing = false

async function inspectPlan(action: () => ReturnType<Window['api']['prepareSync']>) {
  const toastId = showToast({ message: '正在检查同步范围', description: '展开目录并核对目标文件内容…', duration: 0 })
  try { return await reportSyncResult(action) }
  finally { useToastStore.getState().dismiss(toastId) }
}

function showConfirmation(request: Pick<StartSyncRequest, 'leftSource' | 'rightSource' | 'direction'>, preview: SyncPlanPreview, resume: boolean): Promise<boolean> {
  if (useUIStore.getState().pendingSync) return Promise.resolve(false)
  return new Promise((resolve) => useUIStore.getState().setPendingSync({ request, preview, resume, resolve }))
}

export async function confirmSync(request: StartSyncRequest): Promise<StartSyncRequest | null> {
  if (preparing || useUIStore.getState().pendingSync) return null
  preparing = true
  try {
    const response = await inspectPlan(() => window.api.prepareSync(request))
    if (!response.success || !response.data) return null
    if (!await showConfirmation(request, response.data, false)) return null
    return { ...request, planId: response.data.planId }
  } finally { preparing = false }
}

export async function confirmSyncResume(task: SyncTaskSnapshot): Promise<string | null> {
  if (preparing || useUIStore.getState().pendingSync) return null
  preparing = true
  try {
    const response = await inspectPlan(() => window.api.prepareSyncResume())
    if (!response.success || !response.data) return null
    if (!await showConfirmation(task, response.data, true)) return null
    return response.data.planId
  } finally { preparing = false }
}
