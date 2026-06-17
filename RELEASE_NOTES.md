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
