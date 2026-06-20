# 账号管理器浏览器扩展（Chromium MV3）

本目录包含账号管理器（Account Manager）的 Chromium MV3 浏览器扩展实现。扩展负责本地加密保管库、离线 TOTP 生成、分组管理、锁定/解锁、远程账号连接和密文同步。

## 实现者契约

- MVP 阶段仅面向 Chromium MV3。
- 在编写任何同步/加密代码之前，务必阅读 `docs/security.md` 和
  `docs/sync-protocol.md`。
- 所有服务端 I/O 使用 `@2fa/api-client`。不要添加临时的 `fetch` 调用。
- 所有共享的传输格式类型使用 `@2fa/api-types`。不要在本地重复声明。
- 同步密码与派生密钥必须保留在扩展内部。`@2fa/api-client` 已内置
  拒绝可疑请求头的防护。
- 便利优先的本地持久化：将持久化的同步凭证用存储在 IndexedDB 中的不可导出
  AES-GCM `CryptoKey` 进行包裹。需要说明 `docs/security.md` 中指出的权衡
  （无法防御已被攻破的浏览器配置文件）。
- 侧边栏（Side Panel）UI 适配自适应布局，推荐最小宽度为 320px，高度自适应填满浏览器高度。

## 当前实现已提供内容

- `src/App.tsx`：侧边栏主界面、TOTP 条目、分组、同步和设置页面。
- `src/background.ts`：MV3 service worker，负责会话锁定和便利优先的本地同步凭证保护。
- `src/content.ts`：最小手动填充 content script，仅响应用户在侧边栏触发的填充消息。
- `src/utils/crypto.ts`：Web Crypto 封套加密、同步密码包裹和本地设备密钥管理。
- `src/utils/totp.ts`：TOTP 生成逻辑。
- `src/utils/storage.ts`：IndexedDB 和本地配置存储。
- `src/utils/sync.ts`：与服务端的记录级同步流程。
- `public/manifest.json`：Chromium MV3 扩展清单。
- 已配置 `build`、`typecheck` 和 `test` 脚本。
