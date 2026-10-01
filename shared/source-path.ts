import type { SourceConfig, SourceType } from './types'

export function normalizeRemoteBrowserPath(path: string): string {
  const segments: string[] = []
  for (const segment of path.trim().split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function getSourceType(source: SourceConfig | SourceType): SourceType {
  return typeof source === 'string' ? source : source.type
}

function isPathAbsolute(relativePath: string): boolean {
  return relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(relativePath)
}

function isWindowsLikePath(path: string): boolean {
  return path.includes('\\') || /^[A-Za-z]:([\\/]|$)/.test(path)
}

export function normalizeRelativePath(relativePath: string, separator: '/' | '\\'): string {
  if (!relativePath) return ''
  if (relativePath.includes('\0')) throw new Error('relativePath 包含非法空字符')
  if (isPathAbsolute(relativePath)) {
    throw new Error('relativePath 不能使用绝对路径')
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('relativePath 不能包含相对路径跳转')
    }
    if (segment.includes(':')) {
      throw new Error('relativePath 包含非法路径字符')
    }
  }

  return segments.join(separator)
}

export function normalizePathSegment(pathSegment: string): string {
  const normalized = normalizeRelativePath(pathSegment, '/')
  if (!normalized || normalized.includes('/')) {
    throw new Error('路径段必须是合法的单个文件名')
  }
  return normalized
}

export function trimTrailingSeparators(path: string): string {
  if (!path) return path
  if (/^[\\/]+$/.test(path)) return path[0]
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return path.slice(0, 2)
  return path.replace(/[\\/]+$/g, '')
}

export function joinSourcePath(source: SourceConfig | SourceType, basePath: string, relativePath: string): string {
  const sourceType = getSourceType(source)
  if (!relativePath) return basePath

  if (sourceType === 'sftp') {
    const normalizedRelative = normalizeRelativePath(relativePath, '/')
    if (!basePath) return normalizedRelative
    if (/^[\\/]+$/.test(basePath)) return `/${normalizedRelative}`
    return `${trimTrailingSeparators(basePath)}/${normalizedRelative}`
  }

  const separator = isWindowsLikePath(basePath) ? '\\' : '/'
  const normalizedRelative = normalizeRelativePath(relativePath, separator)
  if (!basePath) return normalizedRelative
  return `${trimTrailingSeparators(basePath)}${separator}${normalizedRelative}`
}

export function resolveSourcePath(source: SourceConfig, relativePath: string): string {
  return joinSourcePath(source, source.path, relativePath)
}
