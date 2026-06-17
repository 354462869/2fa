# 架构

本文档描述 2FA MVP 的整体架构以及后续实现必须保持稳定的边界。

## 1. 目标

对应 `requirements.md`：

1. 在 Chromium MV3 扩展中实现离线优先的 TOTP 管理。
2. 所有敏感字段采用客户端加密。服务端是密文同步枢纽。
3. 记录级乐观同步，带冲突检测。
4. 可自托管的单二进制后端，使用 SQLite 存储。
5. 管理后台 SPA 仅限于非敏感元数据和操作。
6. 全程使用 AGPL-3.0。

## 2. 组件关系图

```
+------------------------+       HTTPS/JSON       +---------------------------+
| apps/extension         | <------------------->  | cmd/server                |
| (Chromium MV3, React)  |                        | (Go HTTP API + SQLite)    |
+------------------------+                        +---------------------------+
            ^                                                  ^
            | 打包引用                                          |
            |                                                  | 内嵌
            v                                                  v
+------------------------+                        +---------------------------+
| packages/api-client    |                        | apps/admin                |
| packages/api-types     | <--------------------> | (React SPA)               |
+------------------------+                        +---------------------------+
```

- 浏览器扩展是唯一持有*同步密码*及派生加密密钥的组件。
- 管理后台 SPA 永远不通过用户同步 API 认证。它使用限定于
  `/admin/*` 下的管理专用端点。
- `packages/api-types` 由 `docs/openapi.yaml` 生成，并通过
  `packages/api-client` 被 `apps/extension` 和 `apps/admin` 共同使用。

## 3. 仓库布局

```
2fa/
├── cmd/
│   └── server/                  # main 包，组装 HTTP + SQLite
├── internal/
│   ├── auth/                    # 账号认证（会话、密码哈希）
│   ├── config/                  # 环境变量加载与默认值
│   ├── http/                    # 路由、中间件、handler
│   ├── storage/                 # SQLite 访问；所有 SQL 必须在此处
│   └── sync/                    # 记录级乐观同步逻辑
├── apps/
│   ├── admin/                   # 管理后台 SPA
│   └── extension/               # MV3 扩展
├── packages/
│   ├── api-types/               # 由 openapi.yaml 生成的类型
│   └── api-client/              # 基于 api-types 的 fetch 客户端
├── deploy/                      # Dockerfile + docker-compose 部署配置
├── docs/                        # 本文件、security.md、sync-protocol.md、openapi.yaml
├── data/                        # 本地 SQLite（gitignored）
├── Makefile                     # 顶层编排
├── pnpm-workspace.yaml
├── package.json                 # 根工作区脚本
├── tsconfig.base.json
├── go.mod / go.sum
├── .env.example
├── LICENSE                      # AGPL-3.0
└── README.md
```

后续 agent 须遵守的规则：

- **所有 SQL 必须放在 `internal/storage` 中。** 其他包通过 Go 接口与之交互。
- **`internal/config` 是唯一读取环境变量的地方。** 其他包接收 `Config` 值或其部分字段。
- **`internal/http` 不持有业务状态。** Handler 调用拥有状态的服务，然后将结果
  映射为 `docs/openapi.yaml` 定义的响应格式。
- **`packages/api-types` 是机械生成的。** 它是 `docs/openapi.yaml` 的传输格式镜像，
  不要手动修改其中的语义。
- **`packages/api-client` 对 UI 一无所知。** 它对外暴露类型化的 `fetch` 风格客户端
  和凭证扩展点。

## 4. 后端服务

三个逻辑服务共享同一个二进制：

1. **账号认证** (`/v1/auth/*`)
   - 注册、登录、退出、修改账号密码。
   - 维护不透明的会话令牌（HTTP-only cookie 或 `Authorization` bearer；
     最终选择由后端实现者决定，OpenAPI 契约同时支持两种方式）。
   - 不了解 TOTP secret 或同步密码。
2. **用户同步** (`/v1/sync/*`)
   - 以用户身份认证；范围限定为该用户的密钥库。
   - 分组和条目的记录级乐观 CRDT 端点。
   - 设备注册与撤销端点。
   - 所有负载仅包含密文 + 非敏感元数据。
3. **管理** (`/v1/admin/*`)
   - 独立的管理员登录。
   - 读取非敏感的用户/设备/审计元数据。
   - 禁用账号、撤销设备、查看审计日志。
   - 不能读取密文正文（API 不暴露这些内容）。

## 5. 数据归属

| 数据项                          | 明文持有方           | 密文持有方             |
|---------------------------------|----------------------|-----------------------|
| 账号密码                         | 用户记忆              | 服务端（Argon2id 哈希） |
| 同步密码                         | 用户记忆              | 永不发送至服务端        |
| 设备包裹密钥（浏览器）            | 仅扩展持有            | —                     |
| TOTP secret                     | 扩展内存              | 服务端（密文）          |
| 条目展示字段                     | 扩展内存              | 服务端（密文）          |
| 分组展示字段                     | 扩展内存              | 服务端（密文）          |
| 分组排序、ID、rev                | 扩展 + 服务端         | —                     |
| 审计日志条目                     | 服务端                 | —                     |

## 6. 前端布局

扩展（`apps/extension`）和管理后台 SPA（`apps/admin`）均已实现为 React + TypeScript 应用。
扩展面向 Chromium MV3，负责离线 TOTP、客户端加密、本地锁定和同步操作；管理后台负责用户、设备、审计和系统状态管理。

- 扩展不得引用 `apps/admin`，反之亦然。
- 二者都通过 `@2fa/api-client` 进行 HTTP I/O。
- 二者都通过 `@2fa/api-types` 使用共享类型。

## 7. 构建、运行、测试

- `make install` 解析 Go 模块和 pnpm 包。
- `make build` 生成 `bin/2fa-server` 并运行所有 JS 子项目构建。
- `make test` 运行 `go test ./...` 和 `pnpm -w run test`。
- `make run-server` 基于 `.env` 通过源码运行 API。

## 8. MVP 暂不包含的范围

- 团队或家庭共享。
- 多个独立密钥库或多个远程账号同时在线。
- 服务端同步密码恢复。
- 超出当前确定性 schema 初始化的独立迁移工具。
- Firefox 支持与移动客户端。
