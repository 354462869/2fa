# 本地账号库设计

本文档定义将当前账号管理器（Account Manager）演进为“本地账号管理插件”的长期设计方向。目标是让项目适合长期维护，尤其适合由 AI 辅助持续修改代码时仍能保持清晰边界。

## 1. 产品定位

本项目后续不再只管理 TOTP 验证码，而是管理用户的本地账号资料库。插件负责本地解锁、编辑、复制、检索和加解密；服务端负责认证、设备管理、账号运营元数据、关系元数据和同步。

核心原则：

1. 用户可以离线查看和管理已解锁的账号资料。
2. 服务端可以知道账号管理所需的运营元数据。
3. 服务端不得知道任何能直接接管账号的秘密材料。
4. 服务端代码开源，默认面向用户自托管部署。
5. 同步协议必须继续保留记录级版本控制、冲突检测和墓碑删除。

## 2. 安全边界

本设计采用“服务端可见元数据 + 客户端加密秘密”的模型，而不是完全零知识模型。

### 2.1 服务端允许明文保存

这些字段用于后台管理、筛选、统计、同步冲突定位和账号关系展示：

- 账号类型：`google`、`gpt`、`email`、`phone`、`proxy`、`site`、`totp`、`other`。
- 平台名称：Google、OpenAI、ChatGPT、Gmail、Outlook 等。
- 登录标识：邮箱、用户名、账号编号。是否完整保存由产品配置决定。
- 显示名称：用户给账号取的短名称。
- 状态：`active`、`disabled`、`blocked`、`needs_review`、`archived`。
- 标签、分组、用途、运营备注。
- 账号关系：GPT 账号使用哪个 Google 邮箱、绑定哪个手机号、使用哪个代理。
- 同步元数据：`id`、`rev`、`seq`、`deleted`、`created_at`、`updated_at`。
- 密文字节长度、最后同步时间、设备数量等运维数据。

### 2.2 建议脱敏保存

这些字段有管理价值，但也有隐私风险。默认建议服务端只保存脱敏版本，完整值放入密文：

- 手机号：服务端保存 `+86******1234`，完整号码放入密文。
- 代理地址：服务端可保存地区、协议、可用状态；完整代理账号密码放入密文。
- 邮箱：如果需要后台检索，可以明文保存；如果偏隐私，保存脱敏邮箱和规范化哈希。
- 备注：运营备注可以明文；登录恢复备注、安全问题答案必须密文。

### 2.3 必须密文保存

任何可以直接登录、恢复、接管、绕过验证或冒充用户的材料都必须只在客户端明文出现：

- 账号密码。
- TOTP/2FA secret。
- 备用恢复码。
- 代理认证用户名和密码。
- Cookie、session token、refresh token、API key。
- 安全问题答案。
- 完整手机号、实名信息、身份证件信息。
- 恢复邮箱密码、辅助验证渠道凭证。

### 2.4 不变量

后续任何实现都必须遵守：

- 同步密码不得进入请求体、URL、请求头、Cookie、日志或遥测。
- 服务端不得提供解密密文正文的接口。
- 管理后台不得展示密码、TOTP secret、恢复码、代理认证密码或 token。
- 错误同步密码不得覆盖本地或远程数据。
- 服务端数据库泄露时，攻击者最多获得账号运营元数据和密文秘密，不能直接登录用户管理的账号。

## 3. 数据模型

长期模型应从 `items`/`groups` 演进为通用账号记录。建议以 `accounts` 和 `relations` 为核心表。

### 3.1 `accounts`

`accounts` 表保存服务端可见的账号元数据和客户端加密的秘密正文。

```sql
CREATE TABLE accounts (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  platform TEXT NOT NULL,
  login_identifier TEXT,
  login_identifier_hash TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  tags_json TEXT,
  metadata_json TEXT,
  secret_ciphertext BLOB,
  rev INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
```

字段说明：

- `kind`：账号类型，使用小写稳定字符串，例如 `google`、`gpt`、`phone`、`proxy`。
- `platform`：展示和筛选用平台名称。
- `login_identifier`：服务端可检索的登录标识。需要隐私模式时可为空或脱敏。
- `login_identifier_hash`：默认不上传。若未来需要跨设备去重或检索，必须使用客户端 keyed handle，
  不得上传完整登录标识的普通 SHA-256 等可枚举哈希。
- `metadata_json`：服务端可见元数据，不能放密码、密钥、token。
- `secret_ciphertext`：客户端加密后的秘密正文，服务端只做字节存储。
- `rev`/`seq`：继续沿用现有记录级乐观同步语义。

### 3.2 `relations`

`relations` 表保存账号之间的关系。关系本身通常是服务端可见元数据，因为后台需要展示账号结构。

```sql
CREATE TABLE relations (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  metadata_json TEXT,
  secret_ciphertext BLOB,
  rev INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
```

常见关系类型：

- `login_email`：某个 GPT/OpenAI 账号使用某个 Google/Gmail 账号登录。
- `bound_phone`：账号绑定手机号。
- `uses_proxy`：账号使用代理。
- `has_totp`：账号关联一个 TOTP 验证器记录。
- `recovery_email`：账号配置了恢复邮箱。
- `same_identity`：多个平台账号属于同一身份集合。

### 3.3 加密秘密正文

`secret_ciphertext` 解密后应是版本化 JSON。客户端必须基于 `schema_version` 做兼容处理。

```jsonc
{
  "schema_version": 1,
  "password": "account password",
  "totp_secret": "BASE32SECRET",
  "recovery_codes": ["code-1", "code-2"],
  "proxy_auth": {
    "username": "proxy user",
    "password": "proxy password"
  },
  "full_phone_number": "+8613800000000",
  "private_notes": "security answers, recovery notes, sensitive remarks"
}
```

不同 `kind` 可以使用不同字段，但必须保留 `schema_version`。

## 4. 典型记录示例

### 4.1 Google 邮箱账号

服务端可见：

```jsonc
{
  "kind": "google",
  "platform": "Google",
  "login_identifier": "u***r@gmail.com",
  "display_name": "主 Google 邮箱",
  "status": "active",
  "tags_json": ["个人", "邮箱"],
  "metadata_json": {
    "has_phone": true,
    "has_totp": true,
    "risk_level": "normal"
  }
}
```

密文秘密：

```jsonc
{
  "schema_version": 1,
  "password": "...",
  "totp_secret": "...",
  "recovery_codes": ["..."],
  "private_notes": "..."
}
```

### 4.2 GPT/OpenAI 账号

服务端可见：

```jsonc
{
  "kind": "gpt",
  "platform": "OpenAI",
  "login_identifier": "u***r@gmail.com",
  "display_name": "ChatGPT Plus 账号 1",
  "status": "active",
  "metadata_json": {
    "plan": "plus",
    "login_method": "google_oauth"
  }
}
```

关系：

```jsonc
{
  "relation_type": "login_email",
  "from_account_id": "gpt-account-id",
  "to_account_id": "google-account-id"
}
```

### 4.3 代理记录

服务端可见：

```jsonc
{
  "kind": "proxy",
  "platform": "Proxy",
  "display_name": "香港代理 01",
  "status": "active",
  "metadata_json": {
    "protocol": "socks5",
    "host": "1.2.3.4",
    "port": 1080,
    "region": "HK",
    "last_check_status": "ok"
  }
}
```

密文秘密：

```jsonc
{
  "schema_version": 1,
  "proxy_auth": {
    "username": "...",
    "password": "..."
  }
}
```

## 5. 同步设计

账号库继续沿用现有同步核心：

- 服务端维护每用户单调递增 `seq`。
- 每条 `account` 和 `relation` 有独立 `rev`。
- 推送时必须携带 `expected_rev`。
- 删除使用墓碑记录，不能物理删除后让旧设备复活记录。
- 冲突由客户端解密后合并或提示用户选择。

推荐的新接口形状：

```jsonc
{
  "accounts": [
    {
      "id": "...",
      "kind": "gpt",
      "platform": "OpenAI",
      "login_identifier": "u***r@gmail.com",
      "expected_rev": 3,
      "secret_ciphertext": { "alg": "A256GCM", "iv_b64": "...", "ct_b64": "..." }
    }
  ],
  "relations": [
    {
      "id": "...",
      "from_account_id": "...",
      "to_account_id": "...",
      "relation_type": "login_email",
      "expected_rev": 1
    }
  ]
}
```

迁移期可以同时保留旧的 `items`/`groups` 字段。长期应统一到 `accounts`/`relations` 或更通用的 `records`/`relations`。

## 6. 插件端设计

插件是唯一可以解密秘密正文的组件。长期应拆分为：

- `crypto`：同步密码、DEK、记录加密、记录解密。
- `storage`：IndexedDB 本地账号、关系、密钥和同步游标。
- `sync`：拉取、推送、冲突处理。
- `schema`：账号明文秘密 JSON 的版本化解析和迁移。
- `ui`：账号列表、详情、编辑、复制、关系图、筛选。
- `content-scripts`：未来网页识别和自动填充。

第一阶段不要急着做自动填充。优先完成：

1. 本地加密账号库。
2. 服务端可见账号元数据。
3. Google/GPT/手机号/代理关系管理。
4. 密文同步和第二台设备恢复。

## 7. 管理后台设计

管理后台可以展示服务端可见元数据：

- 账号数量、平台分布、状态分布。
- 某个用户的账号列表和关系图。
- GPT 账号绑定了哪些 Google 邮箱、手机号和代理。
- 哪些账号缺少手机号、缺少 TOTP、代理异常、状态待检查。
- 设备、同步时间、密文大小、冲突统计。

管理后台不得展示：

- 密码。
- TOTP secret。
- 恢复码。
- 代理认证密码。
- Cookie、token、API key。
- `secret_ciphertext` 的解密结果。

## 8. 迁移路径

推荐按小步迁移，避免一次性重写造成项目不可维护。

### 8.1 阶段一：文档和不变量

1. 新增本设计文档。
2. 更新 `security.md`，加入“服务端可见元数据 + 客户端加密秘密”的边界。
3. 新增 AI 维护指南，要求后续改动不得破坏秘密字段密文边界。

### 8.2 阶段二：账号 schema PoC

1. 暂时复用现有 `items` 表和 `ciphertext`。
2. 在密文 JSON 中加入 `schema_version` 和账号秘密字段。
3. 在扩展 UI 中实现 Google/GPT/手机号/代理基础录入。
4. 验证服务端数据库看不到密码、TOTP secret、恢复码和代理认证密码。

### 8.3 阶段三：服务端元数据模型

1. 新增 `accounts` 和 `relations` 表。
2. 新增对应 Go 类型、Store 接口、HTTP 类型和 OpenAPI schema。
3. 保留旧同步 API 一段时间，或提供一次性迁移工具。
4. 管理后台展示账号元数据和关系。

当前实现采用加法迁移：旧 `items` / `groups` 同步继续保留，新的 `accounts` /
`relations` 与旧记录共享同一个每用户 `seq` 流。扩展端从已加密的本地条目派生
服务端可见元数据投影，管理后台只读取该投影，不读取 `secret_ciphertext`。

### 8.4 阶段四：自动填充和高级能力

1. 增加内容脚本和最小权限声明。
2. 支持目标站点识别和手动触发填充。
3. 再考虑自动填充、代理检测、批量导入导出。

## 9. AI 维护规则

后续 AI 修改代码时必须遵守：

1. 任何字段如果能直接登录、恢复或接管账号，必须放入 `secret_ciphertext`。
2. 不要为了搜索方便把密码、TOTP secret、恢复码、token 放到明文字段。
3. 修改 API 契约时必须同步更新 `docs/openapi.yaml`、`packages/api-types` 和 `packages/api-client`。
4. 修改 SQL 时只能放在 `internal/storage`。
5. 修改同步语义时必须更新 `docs/sync-protocol.md`。
6. 修改安全边界时必须更新 `docs/security.md`。
7. 实现后必须验证服务端日志和数据库不出现秘密材料明文。
8. 错误同步密码、解密失败、冲突合并必须有测试覆盖。

## 10. 待确认事项

- 已确认：采用安全默认策略。邮箱/登录标识默认只发布掩码值和规范化哈希；完整值保留在密文。
- 已确认：手机号完整值强制密文保存，服务端只保存是否存在手机号和哈希关系 ID。
- 已确认：代理完整认证信息强制密文保存，服务端关系元数据只保存关系类型/标签/哈希目标 ID。
- 已确认：`accounts`/`relations` 以加法方式与旧 `items`/`groups` 并存；后续是否替换旧模型另行决策。
- 是否需要多密钥库、多远程账号或团队共享。
- 扩展端 KDF 是否从当前 PBKDF2 迁移到 Argon2id。
