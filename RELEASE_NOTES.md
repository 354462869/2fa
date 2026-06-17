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

首次公开发布 2FA 自托管 TOTP 管理器 MVP。

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
