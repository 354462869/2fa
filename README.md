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

### 本地开发

```bash
cp .env.example .env
make install      # go mod download + pnpm install
make build        # 构建所有项目
make test         # 运行全部测试
```

各子项目的独立脚本位于对应目录下。请参阅 `Makefile` 和 `package.json`。

### 使用 Docker 运行服务端和管理后台

适合快速启动同步服务、管理 API 和内置管理后台的场景。数据会保存在 Docker 卷
`2fa-data` 中，SQLite 数据库路径为 `/data/2fa.sqlite`。访问容器暴露的根路径即可打开管理后台。

```bash
docker run --rm -p 8080:8080 \
  -v 2fa-data:/data \
  -e SERVER_ADDR=0.0.0.0:8080 \
  -e SERVER_DB_PATH=/data/2fa.sqlite \
  -e SERVER_PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  -e SERVER_ALLOWED_ORIGINS=http://127.0.0.1:8080 \
  ghcr.io/354462869/2fa-server:v0.1.1
```

打开 `http://127.0.0.1:8080` 会进入管理后台。首次部署时，如果数据库为空，后台会提示创建第一个管理员账号。生产环境请设置强随机 `SERVER_SESSION_SECRET`；如果通过公网 IP 或域名访问，也要把 `SERVER_PUBLIC_ORIGIN` 和 `SERVER_ALLOWED_ORIGINS` 改成实际访问地址。

也可以使用仓库内的 compose 配置进行本地验证：

```bash
docker compose -f deploy/docker-compose.yml up --build
```

### 加载浏览器扩展

1. 构建扩展：

   ```bash
   pnpm --filter @2fa/extension build
   ```

2. 打开 Chromium / Chrome 的扩展管理页，启用“开发者模式”。
3. 选择“加载已解压的扩展程序”，目录选择 `apps/extension/dist`。
4. 点击扩展图标打开侧边栏，首次使用时创建本地保管库并设置同步密码。

### 添加 2FA 账户

在扩展侧边栏点击“添加账户”后，可以用以下任一方式导入 TOTP：

- 手动输入发行方、账户名称和 Base32 密钥。
- 点击“选择图片”，选择包含 `otpauth://totp` 二维码的图片。
- 截图后在二维码识别区域按 `Ctrl+V` 粘贴图片。
- 点击“识别当前页”，自动扫描当前标签页可见区域内的 2FA 二维码。

成功识别后，扩展会自动填入账户信息，并在保存前显示当前二维码预览，便于核对。

### 同步到自托管服务端

1. 先启动服务端，并在内置管理后台完成首个管理员初始化。
2. 在扩展“同步”页填写服务端地址、账号和密码，完成设备注册。
3. 扩展只同步加密后的保管库记录；同步密码仅在客户端用于加解密，服务端不可见。

### 备份与升级

- 备份单位是服务端的 `/data` 目录或 Docker 卷 `2fa-data`。
- 升级镜像前先停止容器并备份 `/data`，避免 SQLite 文件复制不一致。
- 拉取新镜像后使用相同的 `/data` 卷重新启动即可。

## 许可证

本项目使用 **GNU Affero General Public License v3.0 或更高版本**
（AGPL-3.0-or-later）授权。完整文本参见 `LICENSE`。

如果你以网络服务的形式运行本软件的修改版本，AGPL-3.0 要求你必须向该服务
的用户提供相应的源代码。
