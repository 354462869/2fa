# 部署配置

本目录包含 2FA 自托管 MVP 服务端的最小生产形态部署配置。目录内容刻意保持精简；
待后端实现者确定 TLS 终止、反向代理和备份方案后再进行扩展。

目录内容：

- `Dockerfile` 分两阶段构建 Go 服务端，最终在 `distroless/nonroot` 基础上
  交付静态二进制文件。CGO 已禁用，因此后端实现者选择的 SQLite 驱动必须是
  纯 Go 实现（如 `modernc.org/sqlite`）。如需使用基于 C 的驱动，
  请切换到非 distroless 基础镜像并重新启用 CGO。
- `docker-compose.yml` 运行服务端，为 SQLite 数据库使用持久化卷。
  默认仅绑定到 loopback；生产环境必须在前面放置 TLS 终止代理
  （Caddy、nginx、Traefik），并通过部署系统（而非提交到仓库的文件）配置
  `SERVER_PUBLIC_ORIGIN`、`SERVER_ALLOWED_ORIGINS`、`SERVER_SESSION_SECRET`。

本地构建与运行：

```bash
docker compose -f deploy/docker-compose.yml up --build
```

使用公开镜像运行：

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  -v 2fa-data:/data \
  -e SERVER_ADDR=0.0.0.0:8080 \
  -e SERVER_DB_PATH=/data/2fa.sqlite \
  ghcr.io/354462869/2fa-server:v0.1.0
```

首次部署时，如果数据库为空，访问管理后台会提示创建第一个管理员账号。
生产环境必须设置强随机 `SERVER_SESSION_SECRET`，并在服务前放置 HTTPS 反向代理。

备份与升级：

- 备份单位是 `/data`。
- 升级镜像前先停止容器并备份 `/data`。
- SQLite 数据库默认位于 `/data/2fa.sqlite`。

当前部署配置暂不包含的范围：

- TLS 终止配置。
- `/data/2fa.sqlite` 的备份/恢复工具。
- 超出 `/v1/meta/health` 的健康检查端点。
- 管理后台 SPA / 扩展构建流水线（后续实现步骤）。
