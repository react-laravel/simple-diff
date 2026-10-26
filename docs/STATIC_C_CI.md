# simple-diff 静态站托管发布

本工作流仅构建 electron 网页分支；已核实原网页基线 `096638e870ad1baad1df01af18f6d314fdc1b996`。默认分支的 Tauri 业务代码不会作为网页构建输入。手动运行默认只验证，初次正式发布必须在验证成功后明确选择 validate_only=false。

C 仅接收静态产物，不构建、不运行 PHP/Node 服务。独立 `static-c-simple-diff` 账号无 sudo、无服务/Nginx/API/其他站点权限；其根拥有的强制入口仅接受本项目 check、receive、publish，运行凭据不可读。两项仓库加密 Secrets 为 C_STATIC_DEPLOY_SSH_KEY 与 C_STATIC_DEPLOY_KNOWN_HOSTS，不能复用主站或 API key。

程序目录原子切换，逐文件合法 TLS/HTTP 哈希通过后只保留当前一版；失败恢复旧当前版本。IP 站只含8项运行文件，其余 Vite 站只取产物并排除 sourcemap。源码、环境、凭据、测试与 node_modules 不上传。

新的 workflow/脚本须在默认分支和网页分支同步维护（若二者不同）；源提交必须属于网页分支，自动 push 再次校验仍是该分支最新提交，防止旧任务覆盖新版本。旧 deploy-self-hosted 流程保持停用；deploy.php 明确拒绝退役路径。原桌面 CI/Release 保持不变。

首次接通时，六个基础设施提交使用 `[skip ci]` 避免在验证前自动发布。随后从默认分支手动运行 validate_only=true，完成托管构建、现有站点连接和逐文件检查后，再以同一 source_revision 手动运行 validate_only=false。以后网页分支正常 push 自动发布。服务端运行包 ID 同时绑定工作流提交、网页源码提交和全部文件哈希，不把 workflow SHA 误当运行包 ID。
