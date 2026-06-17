# 2fa — 自托管 TOTP 管理器

本仓库提供一个可自托管、端到端加密的 TOTP 管理器：

- `cmd/server` + `internal/...` — Go + SQLite 同步 API 与管理 API。
- `apps/extension` — Chromium MV3 浏览器扩展（离线优先 TOTP）。
- `apps/admin` — React + TypeScript 管理后台 SPA。
- `packages/api-types` — 由 `docs/openapi.yaml` 中的 OpenAPI 契约生成的共享
  TypeScript 类型。
- `packages/api-client` — 基于 `api-types` 构建的 `fetch` 风格薄客户端。

> 状态：MVP 实现。服务端、Chromium 扩展和管理后台 SPA 已实现，可进行
> 本地/自托管验证。需要了解后续变更必须维护的安全与同步边界，请参阅
> `docs/architecture.md`、`docs/security.md` 和 `docs/sync-protocol.md`。

## 为什么采用此布局

- **传输格式的单一事实来源。** `docs/openapi.yaml` 驱动 `packages/api-types`。
  后端 handler 与前端客户端必须匹配此契约。
- **账号认证与同步加密分离。** 服务端认证的是*账号*（用户名 + 密码），
  且永远不会看到用于加密 TOTP 记录的*同步密码*。详见 `docs/security.md`。
- **便利优先的本地持久化。** 在 Chromium 上，我们使用存储在 IndexedDB
  中的不可导出 `CryptoKey` 包裹设备密钥。这可以防止对扩展存储的简单本地
  复制，但**无法**防御已被攻破的浏览器配置文件。相关权衡在
  `docs/security.md` 中有详细说明。
- **记录级乐观同步。** 条目和分组各自独立进行版本控制（每条记录一个
  `rev`，加上每个用户的单调递增 `seq`）。服务端拒绝过期写入；客户端执行合并。
  详见 `docs/sync-protocol.md`。

## 环境要求

- Go 1.22+
- Node 20+ 与 pnpm 9+
- POSIX Shell（Linux / macOS）与 `make`

## 快速开始

```bash
cp .env.example .env
make install      # go mod download + pnpm install
make build        # 构建所有项目
make test         # 运行全部测试
```

各子项目的独立脚本位于对应目录下。请参阅 `Makefile` 和 `package.json`。

## 许可证

本项目使用 **GNU Affero General Public License v3.0 或更高版本**
（AGPL-3.0-or-later）授权。完整文本参见 `LICENSE`。

如果你以网络服务的形式运行本软件的修改版本，AGPL-3.0 要求你必须向该服务
的用户提供相应的源代码。
