# 同步协议（记录级乐观同步）

本文档定义扩展与同步服务端之间的线级冲突与同步契约。后端和扩展实现者
必须保持此契约稳定；`docs/openapi.yaml` 是机器可读的对应文件。

## 1. 目标

- 每个用户一个密钥库。多台设备可以同时推送和拉取。
- 每条*记录*（条目、分组、账号元数据或关系）独立进行版本控制。
- 服务端检测过期写入并拒绝。由客户端执行合并。
- 服务端存储密文、账号库服务端可见元数据以及少量非敏感的同步元数据。
  它不理解或解密秘密正文。
- 墓碑记录是一等公民。删除是一种能够在同步中存活的写入。

## 2. 术语

| 术语              | 含义                                                                   |
|-------------------|------------------------------------------------------------------------|
| `vault`           | 每个用户的容器，持有信封和 seq 计数器。                                   |
| `envelope`        | 已包裹的 DEK 和 KDF 参数（参见 `security.md`）。                          |
| `seq`             | 服务端分配的每用户单调递增计数器，严格递增。                                |
| `rev`             | 每次成功写入时服务端分配的每条记录版本号。                                  |
| `id`              | 客户端选取的随机不透明标识符（UUIDv7 或 128 位随机数）。                     |
| `tombstone`       | 一条 `deleted = true` 的记录项，不携带密文正文。                            |
| `device_id`       | 客户端在注册时选取的随机不透明标识符。                                      |

服务端是 `seq` 和 `rev` 的**权威来源**。客户端不应自行发明这些值。

## 3. 记录

同步时存在四种记录类型。旧客户端只使用 `Item` / `Group`；账号库客户端额外使用
`Account` / `Relation`。服务端保持同一个每用户 `seq` 流。

### 3.1 `Item`

表示单条 TOTP 条目。

```jsonc
// 传输格式（参见 openapi.yaml#/components/schemas/Item）
{
  "id": "01J0Q5...",         // 客户端选取，不可变
  "group_id": "01J0Q5...",   // 可选，null 表示"未分组"
  "rev": 17,                 // 服务端分配
  "seq": 4287,               // 服务端在上次写入时分配
  "deleted": false,          // 墓碑标记
  "updated_at": "2026-06-09T03:21:11Z",
  "ciphertext": {            // deleted == true 时为 null
    "alg": "A256GCM",
    "iv_b64": "...",
    "ct_b64": "..."
  }
}
```

`ciphertext.ct_b64`（在 `DEK_vault` 下解密后）得到包含敏感明文字段（发行方、
账号、secret、备注等）的 JSON 对象，定义见 `requirements.md` 第 3.3 节。
服务端不了解该 schema。

### 3.2 `Group`

表示一个用户可见的分组。

```jsonc
{
  "id": "01J0Q5...",
  "rev": 9,
  "seq": 4291,
  "deleted": false,
  "sort_index": 1024,        // 明文，仅用于排序
  "updated_at": "2026-06-09T03:21:11Z",
  "ciphertext": {            // 展示字段（名称、图标、颜色等）
    "alg": "A256GCM",
    "iv_b64": "...",
    "ct_b64": "..."
  }
}
```

`sort_index` 为明文，因为排序不泄露有意义的内容；分组名称和描述在 `ciphertext` 中。

### 3.3 服务端可以读取的明文字段

旧 `Item` / `Group` 仅限于：

- `id`、`group_id`、`rev`、`seq`、`deleted`、`updated_at`、`sort_index`、
  密文字节长度，以及完整性绑定的 `alg`/`iv_b64`。

其他任意内容必须放在 `ct_b64` 中。

### 3.4 `Account`

表示服务端可见的账号运营元数据和客户端加密的账号秘密正文。

```jsonc
{
  "id": "01J0Q5...",
  "rev": 3,
  "seq": 4312,
  "deleted": false,
  "kind": "gpt",
  "platform": "OpenAI",
  "display_name": "ChatGPT Plus 账号",
  "login_identifier": "u***r@gmail.com",
  "login_identifier_hash": null,
  "status": "active",
  "tags_json": ["GPT"],
  "metadata_json": { "has_password": true, "has_totp": true, "client_created_at": "2026-06-19T08:00:00Z" },
  "secret_ciphertext": { "alg": "A256GCM", "iv_b64": "...", "ct_b64": "..." },
  "created_at": "2026-06-20T03:21:11Z",
  "updated_at": "2026-06-20T03:21:11Z"
}
```

安全默认策略下，`login_identifier` 必须是掩码值或为空；`login_identifier_hash` 默认为空，
不得保存完整登录标识的普通 SHA-256 等可枚举哈希。完整登录标识、密码、TOTP secret、
恢复码、代理认证信息、token 等必须只存在于 `secret_ciphertext`。

### 3.5 `Relation`

表示账号、手机号、代理、恢复邮箱等记录之间的服务端可见关系。

```jsonc
{
  "id": "01J0Q5...-proxy",
  "rev": 1,
  "seq": 4313,
  "deleted": false,
  "kind": "proxy",
  "from_kind": "account",
  "from_id": "01J0Q5...",
  "to_kind": "proxy",
  "to_id": "opaque-proxy-target-id",
  "metadata_json": { "label": "proxy", "client_created_at": "2026-06-19T08:00:00Z" },
  "created_at": "2026-06-20T03:21:12Z",
  "updated_at": "2026-06-20T03:21:12Z"
}
```

关系可以没有 `secret_ciphertext`。如果某类关系未来需要敏感正文，必须放入
`secret_ciphertext`，不得放入 `metadata_json`。扩展需要展示账号加入日期或账号年龄时，优先使用 `metadata_json.client_created_at` 这类非敏感客户端元数据。

## 4. `seq` 计数器

服务端为每个用户维护一个严格单调递增的 `seq` 计数器。每次成功的记录写入
（包括墓碑记录）会将 `seq` 递增 1，并将该值标记到该记录上。客户端使用 `seq`
作为游标：

- "给我所有 `seq > my_last_seq` 的记录" 返回增量数据。
- 客户端持久化它所见过的最大的 `seq`。

该计数器是**按用户**而非按记录类型维护的。这保证了增量数据能够提供跨越
条目、分组、账号和关系的一致性全局排序。

## 5. 端点（记录级）

完整 schema 定义在 `docs/openapi.yaml` 中。相关操作如下：

### 5.1 `GET /v1/sync/vault`

返回用户的密钥库元数据：`kdf_salt_b64`、`envelope`、`seq`（当前服务端 seq）
以及创建/更新时间戳。

### 5.2 `PUT /v1/sync/vault/envelope`

替换信封。用于首次上传和同步密码变更。乐观锁：需要上一个信封的 `rev`
（或 `null` 表示"当前必须为空"）。

### 5.3 `POST /v1/sync/pull`

请求体：

```jsonc
{ "since_seq": 4280, "limit": 500 }
```

响应：

```jsonc
{
  "items":  [ ... 最多 `limit` 条 seq > since_seq 的 Item 记录 ... ],
  "groups": [ ... 最多 `limit` 条 seq > since_seq 的 Group 记录 ... ],
  "accounts": [ ... Account 记录 ... ],
  "relations": [ ... Relation 记录 ... ],
  "next_seq": 4321,        // 返回记录中最高的 seq
  "has_more": false
}
```

记录以非递减 `seq` 顺序返回。客户端在应用该批数据后将游标推进到 `next_seq`。

### 5.4 `POST /v1/sync/push`

请求体：

```jsonc
{
  "items":  [
    { "id": "...", "group_id": "...", "deleted": false,
      "expected_rev": 16,                // null = 必须是一条新记录
      "ciphertext": { "alg": "...", "iv_b64": "...", "ct_b64": "..." } }
  ],
  "groups": [
    { "id": "...", "deleted": false, "sort_index": 1024,
      "expected_rev": null,
      "ciphertext": { "alg": "...", "iv_b64": "...", "ct_b64": "..." } }
  ],
  "accounts": [
    { "id": "...", "deleted": false, "kind": "gpt", "platform": "OpenAI",
      "display_name": "ChatGPT Plus", "login_identifier": "u***r@gmail.com",
      "expected_rev": null,
      "secret_ciphertext": { "alg": "...", "iv_b64": "...", "ct_b64": "..." } }
  ],
  "relations": [
    { "id": "...", "deleted": false, "kind": "proxy", "from_kind": "account",
      "from_id": "...", "to_kind": "proxy", "to_id": "opaque-target-id",
      "expected_rev": null, "metadata_json": { "label": "proxy" } }
  ]
}
```

服务端原子性地处理该批次。对于每条记录：

- 如果 `expected_rev` 与当前服务端 rev 匹配，写入被应用：
  `rev := rev + 1`，`seq := next_seq`。
- 如果 `expected_rev` 为 `null` 且该记录不存在，写入被应用：
  `rev := 1`，`seq := next_seq`。
- 否则该写入因**冲突而被拒绝**。

响应：

```jsonc
{
  "applied":  [ { "id": "...", "kind": "item",  "rev": 18, "seq": 4322 } ],
  "conflicts":[ { "id": "...", "kind": "group", "current_rev": 11,
                  "current_seq": 4319, "current": <Group> } ],
  "next_seq": 4322
}
```

`conflicts` 条目包含该记录的**当前服务端状态**，客户端无需再发起一次往返。
客户端合并后重新推送这些记录（参见第 7 节）。

### 5.5 单条记录查询

以下端点用于定向恢复（例如，冲突响应未包含该记录时）：

- `GET /v1/sync/items/{id}`
- `GET /v1/sync/groups/{id}`
- `GET /v1/sync/accounts/{id}`
- `GET /v1/sync/relations/{id}`

同步端点会返回 `secret_ciphertext`，因为扩展需要在客户端解密；管理端点不得返回该字段。

## 6. 墓碑记录

删除操作以 `"deleted": true` 且 `ciphertext: null` 的记录形式推送。
服务端（在 MVP 中）永久保留墓碑记录，使曾经离线过的旧设备无法复活已删除的条目。

MVP 不包含墓碑清理功能，未来需要明确设计：要么设置长于客户端最长离线窗口的
每条记录 TTL，要么在每个设备确认某一 `seq` 检查点后才执行的"压缩"操作。

## 7. 冲突解决

服务端从不静默覆盖。由客户端做决定。

推荐的客户端行为：

1. 在 `409`（`conflicts` 非空）时，从响应中拉取冲突记录。
2. 在本地解密两个版本。
3. 使用确定性合并：
   - **条目：** 对每个字段优先选择 `updated_at` 较新的版本，
     但绝不使用旧版本的非墓碑记录来复活墓碑记录。
   - **分组：** 对展示字段采用相同的逐字段最后写入者获胜策略；
     `sort_index` 整体替换。
4. 重新加密，然后以设为冲突中服务端 `current_rev` 的 `expected_rev`
   推送合并后的记录。

具体合并规则属于扩展实现范畴；此契约仅保证服务端绝不销毁数据。

## 8. 同步密码错误的安全性

错误的同步密码会产生无法解包的 `DEK_vault` 或 AEAD 验证失败。此时客户端：

- 必须显示清晰的错误提示。
- 不得覆盖本地明文。
- 不得推送任何记录（否则会用错误密钥重新加密并破坏远程密钥库）。
- 可以重试输入不同的同步密码。

此要求对应 AC7 验收标准。

## 9. 设备生命周期

- 设备通过 `POST /v1/devices` 注册，获得不透明 `device_id` 和会话令牌。
- 用户可通过 `DELETE /v1/devices/{id}` 撤销设备，管理员可通过
  `/v1/admin/...` 撤销设备。
- 撤销操作不会删除记录，仅使会话和设备的同步状态失效。

## 10. 版本控制

契约携带 `alg`、`kdf` 及等价字段，使得新版客户端无需重新部署服务端即可
协商更强的原语。服务端将其作为不透明字节存储，不进行解读。
对 `seq`/`rev` 语义的破坏性变更需要新的路径前缀（`/v2/sync/...`）。
