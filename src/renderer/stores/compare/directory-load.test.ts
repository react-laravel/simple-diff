import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../../shared/types'
import { matchChildren } from './directory-load'

const file: FileEntry = { name: 'item', path: 'item', isDirectory: false, size: 10, mtime: 10000 }

describe('matchChildren safety and comparison consistency', () => {
  it('uses a two-second modification time tolerance at the boundary', () => {
    expect(matchChildren([file], [{ ...file, mtime: 12000 }], '')[0].state).toBe('equal')
    expect(matchChildren([file], [{ ...file, mtime: 12001 }], '')[0].reasons.map((reason) => reason.type)).toEqual(['mtime'])
  })

  it('collects both metadata difference reasons', () => {
    const [entry] = matchChildren([file], [{ ...file, size: 11, mtime: 12001 }], '')
    expect(entry.reasons.map((reason) => reason.type)).toEqual(['size', 'mtime'])
  })

  it('does not treat a symbolic link to a directory as an expandable directory', () => {
    const [entry] = matchChildren([{ ...file, isDirectory: true, isSymlink: true }], [], '')
    expect(entry.isDirectory).toBe(false)
    expect(entry.state).toBe('left_only')
  })

  it('reports directory/file and symlink/file type mismatches without recursing', () => {
    const [directory] = matchChildren([{ ...file, isDirectory: true }], [file], '')
    expect(directory.isDirectory).toBe(false)
    expect(directory.reasons).toEqual([{ type: 'type', leftType: 'directory', rightType: 'file' }])
    const [link] = matchChildren([{ ...file, isSymlink: true }], [file], '')
    expect(link.state).toBe('different')
    expect(link.reasons).toEqual([{ type: 'type', leftType: 'symlink', rightType: 'file' }])
  })
})
