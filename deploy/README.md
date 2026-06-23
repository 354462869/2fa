# 部署配置

本目录包含账号管理器（Account Manager）的单容器部署配置。镜像内同时包含 Go 同步 API、SQLite 存储和管理后台 SPA。

目录内容：

- `Dockerfile` 先构建管理后台 SPA，再构建 Go 服务端，最终镜像在 `/` 提供管理后台，在 `/v1/*` 提供 API。
- `docker-compose.yml` 运行单个服务端容器，为 SQLite 数据库使用持久化卷。
  默认仅绑定到 loopback；生产环境建议在前面放置 TLS 终止代理
  （Caddy、nginx、Traefik），并通过部署系统配置
  `SERVER_PUBLIC_ORIGIN`、`SERVER_ALLOWED_ORIGINS`、`SERVER_SESSION_SECRET`。

本地构建与运行：

```bash
docker compose -f deploy/docker-compose.yml up --build
```

使用公开镜像运行：

```bash
docker run --rm -p 8080:8080 \
  -v 2fa-data:/data \
  -e SERVER_ADDR=0.0.0.0:8080 \
  -e SERVER_DB_PATH=/data/2fa.sqlite \
  -e SERVER_PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  -e SERVER_ALLOWED_ORIGINS=http://127.0.0.1:8080 \
  ghcr.io/354462869/2fa-server:v0.2.2
```

首次部署时，如果数据库为空，访问 `http://127.0.0.1:8080` 会进入管理后台并提示创建第一个管理员账号。
生产环境必须设置强随机 `SERVER_SESSION_SECRET`，并在服务前放置 HTTPS 反向代理。

备份与升级：

- 备份单位是 `/data`。
- 升级镜像前先停止容器并备份 `/data`。
- SQLite 数据库默认位于 `/data/2fa.sqlite`。

当前部署配置暂不包含的范围：

- TLS 终止配置。
- `/data/2fa.sqlite` 的备份/恢复工具。
- 超出 `/v1/meta/health` 的健康检查端点。
