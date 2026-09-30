# Simple Diff

基于 Tauri 2 的文件/目录对比工具。

> Electron 完整版（含网页部署）保留在 [`electron`](https://github.com/react-laravel/simple-diff/tree/electron) 分支。

## 功能（main / Tauri）

- **顶栏页签** — 目录对比、文本对比、SSH 管理、对比历史；切换保留对比会话和文本草稿
- **Enter 开始对比** — 数据源和比较依据就绪后，在路径框或设置面板空白处按 Enter；输入法选词、过滤规则换行及弹层交互不触发对比
- **本地 / SFTP 目录对比** — BFS 逐层扫描，子目录懒加载；本地侧 rayon 并发 hash
- **双视图** — 分栏 / 合并视图
- **文件 Diff** — 文本差异、行内字符高亮、写回
- **对比策略** — size / mtime / quick_hash / hash（内容哈希统一为 **SHA-256**，与 Electron 的 SHA-1 不同）
- **过滤** — 排除路径、隐藏点文件
- **本地监听** — 目录变更后标记 dirty 并支持局部重扫
- **对比历史** — 最近 50 次对比记录
- **同步** — 左↔右同步（本地↔本地 / 含 SFTP），支持追加、落盘恢复
- **SSH 管理** — 配置（密钥 AES 加密落盘）、测试连接、浏览远程目录
- **设置 / 主题**

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2 |
| 后端 | Rust（对比 / 文件 / 同步 / SFTP / 历史 / 监听） |
| 前端 | React 19 + Zustand 5 + Tailwind CSS 4 |
| 构建 | Vite 8 |

## 快速开始

```bash
npm install
npm run dev      # tauri dev（会启动 Vite + Rust）
npm run build    # tauri build
npm test
```

## 文件与同步行为

- 文件合并支持撤销、重做和当前文件查找。关闭会话、重新对比、更换来源或关闭窗口前，会检查未保存修改；取消和保存失败均保留草稿。
- 同步前展示方向、范围及覆盖数量。暂停在当前文件完成后生效，期间不能清除或替换任务；队列提供分页和当前文件字节进度。
- 本地和 SFTP 传输使用 64 KiB 缓冲区及同目录临时文件。成功后替换目标，传输失败保留原文件；复制保留修改时间和权限。SFTP 覆盖已有文件要求 `posix-rename@openssh.com` 扩展，不支持时返回错误。
- 保存文件会检查读取时的内容是否已改变，发现外部修改时停止覆盖。该检查不等同于跨程序文件锁。
- 每个新 SSH 连接都在认证前校验 `~/.ssh/known_hosts`。首次连接须先通过系统 SSH 核验服务器指纹并建立信任；未知主机和密钥不匹配均拒绝连接，连接测试会显示原因。
- 文本预览限制为每个文件 32 MB；目录比较和流式同步不受此预览限制。Diff 在 Worker 中计算，超大差异使用有预算的行配对和字符高亮，视图按可见行渲染。
- 恢复数据保存所有未保存的文件草稿，差异结果和撤销历史不会写入浏览器存储。存储不足时会提示先保存文件。

## 验证

macOS 的 SSH 所需 OpenSSL 使用 vendored 静态构建，应用无需依赖 Homebrew 的动态库。签名打包后应检查可执行文件的 `otool -L` 输出，并实际启动 `.app` 验证加载。

```bash
npm run type-check
npm test
npm run build:ui
cargo test --manifest-path src-tauri/Cargo.toml --offline
```

Unix 下的 Rust 集成测试需要 `ssh-keygen`、`/usr/sbin/sshd` 和本机回环监听权限。测试只使用临时目录和临时密钥，覆盖正常连接、主机换钥、未信任主机、SFTP 覆盖与传输失败保护。

性能样例与验证边界见 [改进记录](docs/review-notes.md)。SFTP 原子重命名遵循 [OpenSSH 协议说明第 4.3 节](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)。

## 项目结构

```text
shared/                 前后端共享 TS 类型与纯算法（text-diff）
src/renderer/           React UI
src-tauri/              Rust 后端
  src/commands.rs       Tauri 命令入口
  src/compare.rs        目录对比
  src/sync.rs           同步引擎
  src/ssh.rs            SFTP / SSH
  src/history.rs        对比历史
```

## 许可证

MIT
