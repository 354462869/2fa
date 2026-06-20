# AGENTS.md

本文件适用于整个仓库。后续 AI 或人工修改本项目时，必须优先遵守这里的项目规则。

## 项目定位

- 项目名称：账号管理器（Account Manager）。
- 当前形态：Go + SQLite 同步服务、React 管理后台、Chromium MV3 浏览器扩展、共享 TypeScript API 包。
- 内部历史命名仍保留 `2fa`：Go module、NPM workspace 包名、Docker 镜像名、数据库路径和二进制名不要随意重命名。

## 安全边界

- 服务端和管理后台只能看到安全默认元数据。
- 密码、TOTP secret、恢复码、完整手机号、代理认证、Cookie、token、API key、安全问题答案和私密备注必须只存在于客户端加密正文。
- 管理 API 不得返回、存储或渲染 `secret_ciphertext` / `ct_b64`。
- 扩展端同步投影不得上传完整登录标识，也不得上传完整标识、手机号或代理的普通 SHA-256 等可枚举哈希。
- content script 只能响应用户手动触发的填充操作，不得静默自动填充或后台填充。

## 兼容性规则

- 保留旧 `items` / `groups` 同步格式兼容。
- `accounts` / `relations` 是加法扩展，不得破坏旧客户端基本同步。
- 关系模型保留通用字段 `kind/from_kind/from_id/to_kind/to_id`，同时兼容 `relation_type/from_account_id/to_account_id` 别名。
- SQLite 迁移必须幂等、可重复启动，旧数据必须有明确 backfill 策略。

## 发布交付物要求

每个正式 release 必须同时具备以下交付物，缺一不可：

1. Docker 镜像：`ghcr.io/354462869/2fa-server:vX.Y.Z`，并由主 release workflow 推送 `latest`。
2. 源码包：`2fa-source-vX.Y.Z.tar.gz`，内容来自当前 tag 的源码快照。
3. 浏览器插件包：`2fa-extension-vX.Y.Z.zip`，内容为 `apps/extension/dist`，必须包含 `manifest.json`、`background.js`、`content.js`、`popup.html`、assets 和 icons。
4. Release 版本说明：`RELEASE_NOTES.md` 顶部必须包含对应 `# vX.Y.Z` 条目，并说明功能变化、兼容性、升级/备份要求和 release 资产。

发布前必须确认版本号一致：

- `package.json`
- `apps/admin/package.json`
- `apps/extension/package.json`
- `packages/api-types/package.json`
- `packages/api-client/package.json`
- `apps/extension/public/manifest.json`
- `docs/openapi.yaml` 的 `info.version` 和版本示例
- `internal/http/router.go` 的 `serverVersion`
- README、deploy 文档和 release notes 中的 Docker/扩展包示例

## 发布前验证

发版前至少运行并通过：

```bash
make test
make build
make typecheck
make vet
git diff --check
```

还必须做真实入口验证：

- HTTP smoke：`/v1/meta/health`、`/v1/meta/version`、首次 admin 初始化、账号/关系 push/pull、admin accounts/relations 不泄露密文。
- Docker smoke：在有 Docker 权限的环境运行 `docker build -f deploy/Dockerfile -t 2fa-server:pre-release .`，并用容器验证 `/data` 持久化、SQLite 文件创建、内置管理后台和 `/v1/meta/health`。
- 浏览器插件包检查：构建后确认 `apps/extension/dist/content.js` 存在，zip 包能被 Chromium/Chrome 以“加载已解压扩展”方式加载。

如果本机没有 Docker 或浏览器权限，必须在最终报告中明确说明未验证项，并要求在 CI 或具备权限的环境补验。

## 修改约束

- 不要提交、打 tag 或 push，除非用户明确要求。
- 不要执行破坏性 git 命令，例如 `reset --hard`、`checkout --`、`clean` 或 force push。
- 不要读取或提交 `.env`、密钥、凭证、token 文件。
- 不新增依赖，除非先解释必要性并完成构建/安全验证。
- 不使用 `as any`、`@ts-ignore`、`@ts-expect-error` 或空 `catch {}` 来掩盖问题。

## 推荐检查命令

```bash
rg -n "AuthNest|2FA 管理器|2FA 验证器|TOTP 管理器" .
rg -n "as any|@ts-ignore|@ts-expect-error|catch \\{\\}" apps internal packages docs
rg -n "secret_ciphertext|ct_b64|totp_secret|full_phone_number|proxy_auth" apps internal packages docs
```

命中敏感字段名不一定是问题，但必须确认它们只出现在密文结构、测试假数据或文档安全示例中。
