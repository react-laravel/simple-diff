import type { CompareEntry, CompareState, CompareStats, DiffReason, FileEntry, StrategyName } from '@shared/types'
import { DAY_MS, hashString, NOW, type MockSide } from './mock-fixtures'

/**
 * 浏览器预览用的示例目录树。
 * 覆盖 7 个结果筛选桶、三层嵌套、点文件，以及可读写的文件内容。
 */

const STATE_BY_CODE: Readonly<Record<string, CompareState>> = {
  E: 'equal',
  D: 'different',
  L: 'left_only',
  R: 'right_only',
  P: 'pending',
}

/** `<状态码> <相对路径>`，以 `/` 结尾表示目录；父目录始终排在子项之前。 */
const TREE_SPEC = `
E .editorconfig
D .env.example
E .gitignore
D README.md
D package.json
D package-lock.json
E tsconfig.json
E vite.config.ts
E .github/
E .github/workflows/
D .github/workflows/ci.yml
E .github/workflows/release.yml
R .github/workflows/lint.yml
E public/
E public/robots.txt
D public/manifest.json
L public/sw.js
E public/locales/
D public/locales/en.json
D public/locales/zh-CN.json
R public/locales/ja.json
E src/
D src/main.tsx
D src/App.tsx
E src/index.css
E src/vite-env.d.ts
E src/components/
E src/components/Avatar.tsx
D src/components/Badge.tsx
E src/components/Button.tsx
D src/components/Card.tsx
L src/components/Dialog.tsx
E src/components/Drawer.tsx
E src/components/Input.tsx
D src/components/Menu.tsx
D src/components/Table.tsx
R src/components/Tabs.tsx
L src/components/Toast.tsx
E src/components/Tooltip.tsx
E src/components/icons/
E src/components/icons/check.svg
E src/components/icons/chevron.svg
D src/components/icons/close.svg
L src/components/icons/search.svg
E src/hooks/
E src/hooks/useDebounce.ts
D src/hooks/useFetch.ts
E src/hooks/useTheme.ts
E src/pages/
D src/pages/Dashboard.tsx
D src/pages/Home.tsx
E src/pages/Login.tsx
E src/pages/NotFound.tsx
R src/pages/Profile.tsx
L src/pages/Reports.tsx
D src/pages/Settings.tsx
E src/utils/
E src/utils/dates.ts
E src/utils/format.ts
D src/utils/math.ts
D src/utils/request.ts
E src/utils/storage.ts
P src/utils/validate.ts
L src/legacy/
L src/legacy/jquery-shim.js
L src/legacy/polyfill.js
L src/legacy/styles.css
E server/
D server/index.js
L server/.env.lock
E server/lib/
E server/lib/db.js
D server/lib/logger.js
P server/lib/mailer.js
E server/routes/
E server/routes/auth.js
D server/routes/files.js
E server/routes/health.js
L server/routes/sync.js
E server/routes/users.js
E assets/
E assets/logo.svg
E assets/favicon.ico
E assets/fonts/
E assets/fonts/Inter.woff2
R assets/fonts/JetBrains.woff2
E assets/images/
E assets/images/bg.jpg
D assets/images/hero.png
L assets/images/avatar.png
E assets/images/icon-192.png
E assets/images/icon-512.png
D assets/images/og-card.png
E docs/
D docs/CHANGELOG.md
E docs/CONTRIBUTING.md
E docs/api/
E docs/api/errors.md
R docs/api/legacy.md
E docs/api/overview.md
D docs/api/reference.md
D docs/api/webhooks.md
E scripts/
E scripts/build.sh
E scripts/check.sh
D scripts/deploy.sh
P scripts/seed.ts
R dist/
R dist/bundle.css
R dist/bundle.js
R dist/index.html
E tests/
D tests/app.test.ts
E tests/setup.ts
E tests/e2e/
D tests/e2e/compare.spec.ts
E tests/e2e/login.spec.ts
E tests/e2e/nav.spec.ts
D tests/e2e/sync.spec.ts
P tests/e2e/upload.spec.ts
`

interface MockNode {
  readonly relativePath: string
  readonly name: string
  readonly isDirectory: boolean
  readonly state: CompareState
}

function parseTreeSpec(): readonly MockNode[] {
  const nodes: MockNode[] = []

  for (const rawLine of TREE_SPEC.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const separatorIndex = line.indexOf(' ')
    const code = line.slice(0, separatorIndex)
    const rawPath = line.slice(separatorIndex + 1)
    const isDirectory = rawPath.endsWith('/')
    const relativePath = isDirectory ? rawPath.slice(0, -1) : rawPath
    const state = STATE_BY_CODE[code]

    if (!state) throw new Error(`未知的对比状态码：${code}`)

    nodes.push({
      relativePath,
      name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
      isDirectory,
      state,
    })
  }

  return nodes
}

const MOCK_NODES = parseTreeSpec()
const NODE_BY_PATH = new Map(MOCK_NODES.map((node) => [node.relativePath, node]))

function hasSide(state: CompareState, side: MockSide): boolean {
  if (side === 'left') return state !== 'right_only'
  return state !== 'left_only'
}

function createFileEntry(node: MockNode, side: MockSide): FileEntry {
  const seed = hashString(`${node.relativePath}:${node.isDirectory}`)
  const baseSize = node.isDirectory ? 0 : 180 + (seed % 48_000)
  const baseMtime = NOW - (seed % 45) * DAY_MS - (seed % 3600) * 1000
  const drifted = side === 'right' && node.state === 'different'

  return {
    name: node.name,
    path: node.relativePath,
    isDirectory: node.isDirectory,
    size: drifted ? baseSize + 37 + (seed % 512) : baseSize,
    mtime: drifted ? baseMtime + 2 * 3600 * 1000 : baseMtime,
  }
}

function createReasons(node: MockNode, left: FileEntry, right: FileEntry, strategies: readonly StrategyName[]): readonly DiffReason[] {
  if (node.state !== 'different' || node.isDirectory) return []
  const reasons: DiffReason[] = []
  for (const strategy of strategies) {
    if (strategy === 'size' && left.size !== right.size) {
      reasons.push({ type: 'size', leftSize: left.size, rightSize: right.size })
    } else if (strategy === 'mtime' && Math.abs(left.mtime - right.mtime) > 2000) {
      reasons.push({ type: 'mtime', leftMtime: left.mtime, rightMtime: right.mtime })
    } else if (strategy === 'hash' || strategy === 'quick_hash') {
      reasons.push({
        type: strategy,
        leftHash: hashString(`${node.relativePath}:${strategy}:left`).toString(16).padStart(8, '0'),
        rightHash: hashString(`${node.relativePath}:${strategy}:right`).toString(16).padStart(8, '0'),
      })
    }
  }
  return reasons
}

function createCompareEntry(node: MockNode, strategies: readonly StrategyName[]): CompareEntry {
  const left = hasSide(node.state, 'left') ? createFileEntry(node, 'left') : undefined
  const right = hasSide(node.state, 'right') ? createFileEntry(node, 'right') : undefined
  const reasons = left && right ? createReasons(node, left, right, strategies) : []

  return {
    relativePath: node.relativePath,
    name: node.name,
    isDirectory: node.isDirectory,
    state: node.state === 'different' && !node.isDirectory ? reasons.length > 0 ? 'different' : 'equal' : node.state,
    left,
    right,
    reasons,
  }
}

export function createMockCompareEntries(strategies: readonly StrategyName[] = ['size', 'mtime', 'quick_hash', 'hash']): readonly CompareEntry[] {
  return MOCK_NODES.map((node) => createCompareEntry(node, strategies))
}

export function summarizeMockEntries(entries: readonly CompareEntry[]): CompareStats {
  let equal = 0
  let different = 0
  let leftOnly = 0
  let rightOnly = 0

  for (const entry of entries) {
    if (entry.state === 'equal') equal += 1
    else if (entry.state === 'different') different += 1
    else if (entry.state === 'left_only') leftOnly += 1
    else if (entry.state === 'right_only') rightOnly += 1
  }

  return { total: entries.length, equal, different, leftOnly, rightOnly }
}

/** 相对目录下、指定一侧可见的直接子项。 */
export function listMockChildren(side: MockSide, relativeDir: string): readonly FileEntry[] {
  const prefix = relativeDir ? `${relativeDir}/` : ''

  return MOCK_NODES
    .filter((node) => {
      if (!hasSide(node.state, side)) return false
      if (!node.relativePath.startsWith(prefix)) return false
      const rest = node.relativePath.slice(prefix.length)
      return rest.length > 0 && !rest.includes('/')
    })
    .map((node) => createFileEntry(node, side))
}

// ─── 文件内容 ─────────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'ico', 'woff2', 'webp', 'zip', 'pdf'])

function isBinaryPath(relativePath: string): boolean {
  const dotIndex = relativePath.lastIndexOf('.')
  if (dotIndex < 0) return false
  return BINARY_EXTENSIONS.has(relativePath.slice(dotIndex + 1).toLowerCase())
}

function buildBaseLines(relativePath: string): readonly string[] {
  const seed = hashString(relativePath)
  const lineCount = 16 + (seed % 20)
  const lines = [
    `// ${relativePath}`,
    '// 浏览器预览示例内容（simple-diff mock fixtures）',
    '',
  ]

  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`const field${index} = 'value-${(seed + index * 7919) % 9973}'`)
  }

  lines.push('')
  lines.push(`export default { path: '${relativePath}', fields: ${lineCount} }`)
  return lines
}

/** 右侧内容在 `different` 条目上产生改行 + 增行 + 删行，覆盖 diff 视图的三种行型。 */
function driftLines(lines: readonly string[], relativePath: string): readonly string[] {
  const seed = hashString(`${relativePath}:drift`)
  const drifted: string[] = []

  lines.forEach((line, index) => {
    if (index === 5) {
      drifted.push(`// 发布分支新增：${relativePath}`)
    }
    if (index === 11 && lines.length > 14) {
      return
    }
    drifted.push(index > 2 && index % 7 === 3 ? `${line} // patched ${(seed + index) % 97}` : line)
  })

  return drifted
}

const writtenContent = new Map<string, string>()

function contentKey(side: MockSide, relativePath: string): string {
  return `${side}:${relativePath}`
}

export function writeMockFile(side: MockSide, relativePath: string, content: string): void {
  writtenContent.set(contentKey(side, relativePath), content)
}

export function readMockFile(side: MockSide, relativePath: string): string {
  const override = writtenContent.get(contentKey(side, relativePath))
  if (override != null) return override

  if (isBinaryPath(relativePath)) {
    return [
      `// ${relativePath}`,
      '// 二进制示例文件：浏览器预览不提供真实字节内容。',
      `// 大小约 ${180 + (hashString(relativePath) % 48_000)} 字节。`,
    ].join('\n')
  }

  const baseLines = buildBaseLines(relativePath)
  const node = NODE_BY_PATH.get(relativePath)
  const lines = side === 'right' && node?.state === 'different'
    ? driftLines(baseLines, relativePath)
    : baseLines

  return lines.join('\n')
}
