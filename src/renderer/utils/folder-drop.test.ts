// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  findFolderDropTarget,
  FOLDER_DROP_TARGET_ATTR,
  nativeDropCssCandidates,
  elementContainsPoint,
  getDroppedFolderPath,
} from './folder-drop'

function dropEvent(data: {
  files?: ArrayLike<File>
  uriList?: string
  plain?: string
}): { dataTransfer: DataTransfer } {
  const files = Object.assign(data.files ?? [], {
    item: (index: number) => (data.files ? data.files[index] ?? null : null),
  }) as unknown as FileList

  return {
    dataTransfer: {
      files,
      getData: (type: string) => {
        if (type === 'text/uri-list') return data.uriList ?? ''
        if (type === 'text/plain') return data.plain ?? ''
        return ''
      },
    } as DataTransfer,
  }
}

describe('getDroppedFolderPath', () => {
  it('prefers getPathForFile when the HTML5 file list is present', () => {
    const getPathForFile = vi.fn(() => '/native/drop')
    const path = getDroppedFolderPath(
      dropEvent({ files: [{ name: 'src' } as File], plain: '/ignored' }),
      getPathForFile,
    )
    expect(path).toBe('/native/drop')
    expect(getPathForFile).toHaveBeenCalledTimes(1)
  })

  it('reads file:// URIs when native paths are empty', () => {
    const path = getDroppedFolderPath(
      dropEvent({ uriList: '#comment\nfile:///Users/sam/Code%20Folder\n' }),
      () => '',
    )
    expect(path).toBe('/Users/sam/Code Folder')
  })

  it('falls back to plain text paths', () => {
    expect(getDroppedFolderPath(dropEvent({ plain: '/tmp/left' }), () => '')).toBe('/tmp/left')
  })
})

describe('native drop hit testing', () => {
  it('keeps CSS pixels as-is and also tries devicePixelRatio scaling', () => {
    const original = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    expect(nativeDropCssCandidates({ x: 200, y: 80 })).toEqual([
      { x: 200, y: 80 },
      { x: 100, y: 40 },
    ])
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: original })
  })

  it('reports whether a CSS point sits inside an element', () => {
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 60,
      width: 100,
      height: 40,
      toJSON() {},
    })
    expect(elementContainsPoint(element, 10, 20)).toBe(true)
    expect(elementContainsPoint(element, 110, 60)).toBe(true)
    expect(elementContainsPoint(element, 9, 40)).toBe(false)
  })

  it('returns the unique drop target and ignores ambiguous retina collisions', () => {
    document.body.innerHTML = `
      <div ${FOLDER_DROP_TARGET_ATTR} id="left"></div>
      <div ${FOLDER_DROP_TARGET_ATTR} id="right"></div>
    `
    const left = document.getElementById('left')!
    const right = document.getElementById('right')!
    vi.spyOn(left, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 80, left: 0, top: 80, right: 200, bottom: 120, width: 200, height: 40, toJSON() {},
    })
    vi.spyOn(right, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 140, left: 0, top: 140, right: 200, bottom: 180, width: 200, height: 40, toJSON() {},
    })

    const original = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    expect(findFolderDropTarget({ x: 20, y: 100 })).toBe(left)
    // 逻辑坐标落在右侧时，÷2 会落到左侧：两种解释冲突，不强行命中
    expect(findFolderDropTarget({ x: 20, y: 160 })).toBeNull()
    // 物理像素落在右侧：原值落空，÷2 唯一命中右侧
    expect(findFolderDropTarget({ x: 20, y: 320 })).toBe(right)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: original })
    document.body.innerHTML = ''
  })
})
