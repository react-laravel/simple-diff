/**
 * 把 Finder / 资源管理器拖入的目录解析成绝对路径。
 *
 * WKWebView 里 HTML5 `File` 没有真实路径；Tauri 的 `onDragDropEvent` 会先把路径
 * 塞进 `getPathForFile`。原生事件才是主路径，这里的 HTML5 解析只是后备。
 */
export function getDroppedFolderPath(
  event: { dataTransfer: DataTransfer },
  getPathForFile: (file: File) => string,
): string | null {
  const files = event.dataTransfer.files
  if (files.length > 0) {
    const filePath = getPathForFile(files[0])
    if (filePath) return filePath
  }

  const uriList = event.dataTransfer.getData('text/uri-list')
  if (uriList) {
    const uri = uriList
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))

    if (uri?.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(uri).pathname)
      } catch {
        // Ignore malformed URI payloads and continue with other fallbacks.
      }
    }
  }

  const plainText = event.dataTransfer.getData('text/plain').trim()
  if (plainText) {
    if (plainText.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(plainText).pathname)
      } catch {
        return plainText
      }
    }

    return plainText
  }

  return null
}

export const FOLDER_DROP_TARGET_ATTR = 'data-folder-drop'

export function nativeDropCssCandidates(position: { x: number; y: number }): readonly { x: number; y: number }[] {
  const scale = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1
  const asIs = { x: position.x, y: position.y }
  if (scale === 1) return [asIs]
  return [asIs, { x: position.x / scale, y: position.y / scale }]
}

export function elementContainsPoint(element: Element, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/**
 * macOS 上 Tauri 有时给物理像素、有时已经是 CSS 像素。两种解释都试一遍，
 * 只有唯一命中某个目录框时才认；对不上就交给空槽填充，避免把右侧拖入写到左侧。
 */
export function findFolderDropTarget(position: { x: number; y: number }): Element | null {
  if (typeof document === 'undefined') return null
  const targets = [...document.querySelectorAll(`[${FOLDER_DROP_TARGET_ATTR}]`)]
  if (targets.length === 0) return null

  const hits = new Set<Element>()
  for (const point of nativeDropCssCandidates(position)) {
    const matched = targets.filter((element) => elementContainsPoint(element, point.x, point.y))
    if (matched.length === 1) {
      hits.add(matched[0])
    }
  }

  if (hits.size === 1) {
    return [...hits][0]
  }
  return null
}
