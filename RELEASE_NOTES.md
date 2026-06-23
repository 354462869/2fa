# v0.2.2

本版本修复 Chromium 扩展账号创建时间和账号卡片空闲展示体验，确保本地创建时间随同步传播，同时兼容旧服务端的严格 JSON 校验。

## 更新内容

- 扩展账号列表排序改为账号类型优先、客户端创建时间倒序，不再使用修改时间决定同类型账号顺序。
- 账号创建时间由扩展本地生成并通过同步元数据传播；服务端仅作为同步媒介，旧服务端不会因未知顶层字段返回 `Invalid JSON`。
- 账号卡片在侧边栏 30 秒无操作后，第二排改为左侧显示备注、右侧显示账号年龄；鼠标悬浮、点击、滚动、键盘、触摸等操作会立即恢复代理/手机号/密码/编辑/删除按钮。
- 账号年龄按创建时间计算，未满月显示 `N天`，满月显示 `M月D天`，满年显示 `Y年M月D天`。
- 增加账号年龄、创建时间回退和排序逻辑测试，覆盖旧数据缺少创建时间时按当天处理的兼容行为。

## 兼容性和升级说明

- 服务端数据库不需要新增迁移；创建时间通过既有 `metadata_json` 同步，兼容已发布的 `v0.2.1` 服务端严格 JSON 解码。
- Chromium 扩展需要重新加载新版 `apps/extension/dist`，旧扩展同步时可能仍显示 `Invalid JSON`。
- 旧账号如果没有历史创建时间，只能按已有同步元数据或本地当前时间展示，无法自动恢复真实历史创建日期。
- 升级 Docker 镜像前请先停止容器并备份 `/data`。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.2.2`
- 源码包：`2fa-source-v0.2.2.tar.gz`
- 浏览器扩展包：`2fa-extension-v0.2.2.zip`

# v0.2.1

本版本改进 Chromium 扩展账号列表的高密度展示体验，并修复本地解锁和 IndexedDB 升级路径中的同步状态问题。

## 更新内容

- 扩展账号库改为紧凑两排布局，第一排显示账号类型、账号和 2FA，第二排显示代理、手机号、密码状态以及编辑/删除操作。
- 账号按账号类型优先、更新时间倒序排序，分组支持颜色标识，账号类型使用不同视觉样式区分。
- 缺失代理、手机号、密码和 2FA 时使用红色状态提示；账号、代理 IP 和 2FA hover 时显示完整信息。
- 账号、代理、手机号、密码和 2FA 均支持点击复制，密码仍不直接展示明文，代理只展示和复制 host/IP。
- 删除账号改为二次确认弹层，可在已连接同步服务时选择同步删除或仅本地删除。
- 修复保存同步密码失败时后台误标记为已解锁的问题，并补齐 IndexedDB `accounts` / `relations` store 的升级路径。

## 兼容性和升级说明

- 服务端 API 和同步协议保持兼容；本版本不需要数据库迁移。
- Chromium 扩展需要重新加载新版 `apps/extension/dist`。
- 升级 Docker 镜像前请先停止容器并备份 `/data`。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.2.1`
- 源码包：`2fa-source-v0.2.1.tar.gz`
- 浏览器扩展包：`2fa-extension-v0.2.1.zip`

# v0.2.0

本版本将项目从 TOTP/2FA 管理器演进为账号管理器（Account Manager），新增账号元数据、账号关系、管理后台关系图和用户手动触发的网页填充能力。

## 更新内容

- 浏览器扩展更名为“账号管理器”，账号库 UI 支持账号分类、密码、手机号、代理和关联 Google 信息的本地加密保存。
- 新增 `accounts` / `relations` 同步记录类型，服务端只保存安全默认元数据，密码、TOTP secret、完整手机号、代理认证和私密备注保留在客户端加密正文中。
- `accounts` / `relations` 增加 `created_at`，旧数据库会在启动迁移时从 `updated_at` 回填。
- 关系 API 保留通用字段 `kind/from_kind/from_id/to_kind/to_id`，同时提供设计别名 `relation_type/from_account_id/to_account_id`。
- 管理后台新增账号/关系元数据展示和只读关系图，不返回 `secret_ciphertext`。
- 扩展新增手动触发的 content script 填充入口，只有用户点击账号卡片“填充”时才向当前标签页发送账号/密码。
- 扩展同步投影改为独立版本化账号秘密密文，不再复用旧 item ciphertext。

## 兼容性和升级说明

- 旧 `items` / `groups` 同步格式继续兼容；`accounts` / `relations` 为加法扩展。
- OpenAPI `PullResponse.accounts` / `PullResponse.relations` 为兼容旧客户端的可选字段；新版服务端会在启用账号投影时返回这些数组。
- 升级 Docker 镜像前请先停止容器并备份 `/data`。
- Chromium 扩展需要重新加载新版 `apps/extension/dist`，以包含新的 `content.js`。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.2.0`
- 源码包：`2fa-source-v0.2.0.tar.gz`
- 浏览器扩展包：`2fa-extension-v0.2.0.zip`

# v0.1.3

本版本修复服务端 Docker 镜像构建流程，确保内置管理后台的镜像能够在 GitHub Actions 中成功构建并推送。

## 更新内容

- Docker 构建阶段补齐根级 TypeScript 配置文件，支持在容器内构建共享包和管理后台。
- 继续提供单容器部署形态：`/` 为管理后台，`/v1/*` 为 API。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.1.3`
- 浏览器扩展包：`2fa-extension-v0.1.3.zip`

# v0.1.2

本版本将管理后台 SPA 打包进服务端 Docker 镜像，部署后访问容器根路径即可打开后台页面。

## 更新内容

- Docker 镜像内置管理后台，`/` 提供后台页面，`/v1/*` 继续提供 API。
- 首次访问后台时，如果数据库为空，可直接在页面中初始化管理员账号密码。
- 管理后台默认使用当前访问地址作为 API 地址，适配 IP + 端口、域名和反向代理部署。
- 发布 workflow 构建共享包、扩展包、管理后台，并推送包含后台的服务端镜像。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.1.2`
- 浏览器扩展包：`2fa-extension-v0.1.2.zip`

## 升级说明

- 升级镜像前请先停止容器并备份 `/data`。
- 使用 IP + 端口部署时，将 `SERVER_PUBLIC_ORIGIN` 和 `SERVER_ALLOWED_ORIGINS` 设置为实际访问地址，例如 `http://192.168.6.32:8085`。

# v0.1.1

本版本改进 Chromium 扩展添加 2FA 账户时的二维码导入体验，并补充项目使用说明。

## 更新内容

- 添加账户时支持直接粘贴截图识别二维码。
- 添加账户时支持扫描当前标签页可见区域内的 2FA 二维码。
- 选择图片、粘贴图片或扫描当前页识别成功后，会自动填入账户信息并显示当前二维码预览。
- README 增加 Docker 运行、浏览器扩展加载、账户添加、同步、备份与升级说明。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.1.1`
- 浏览器扩展包：`2fa-extension-v0.1.1.zip`

## 升级说明

- 服务端 API 与数据格式保持兼容。
- 升级 Docker 镜像前请先停止容器并备份 `/data`。
- Chromium 扩展重新加载新构建的 `apps/extension/dist` 即可使用新的二维码识别入口。

# v0.1.0

首次公开发布账号管理器（Account Manager）MVP。

## 主要功能

- Go + SQLite 同步服务，提供账号认证、设备管理、管理 API 和记录级同步 API。
- Chromium MV3 侧边栏扩展，支持本地加密保管库、TOTP 生成、分组、远程连接和自动同步。
- React 管理后台，支持首次部署初始化管理员、用户目录、设备管理和审计日志。
- 客户端端到端加密：服务端只保存密文和同步元数据，不接收同步密码。
- Docker 单容器部署，SQLite 数据持久化到 `/data`。

## Release 资产

- 服务端 Docker 镜像：`ghcr.io/354462869/2fa-server:v0.1.0`
- 浏览器扩展包：`2fa-extension-v0.1.0.zip`

## 快速开始

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  -v 2fa-data:/data \
  -e SERVER_ADDR=0.0.0.0:8080 \
  -e SERVER_DB_PATH=/data/2fa.sqlite \
  ghcr.io/354462869/2fa-server:v0.1.0
```

首次打开管理后台时，如果数据库为空，会提示创建第一个管理员账号。

## 升级和备份

- 升级前请备份 `/data`。
- SQLite 文件位于 `/data/2fa.sqlite`。
- 建议停止容器后再复制 `/data`，避免备份不一致。

## 已知限制

- 目前仅面向 Chromium MV3 扩展。
- 同步冲突仍以确定性合并为主，复杂冲突确认 UI 将在后续版本完善。
- 生产环境建议在服务前放置 HTTPS 反向代理，并设置强随机 `SERVER_SESSION_SECRET`。
