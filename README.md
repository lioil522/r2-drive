# R2 Drive

中文界面的多账号 Cloudflare R2 网盘。用多个免费 10 GB 账号拼出一个大容量盘：优先整文件存放，单账号放不下时可跨账号分段，小文件回填前面的剩余空间；同时提供接近 Cloudflare 官方 R2 控制台的管理能力（存储桶、CORS、生命周期、对象锁、自定义域名、事件通知、分片清理、用量统计），以及跨账号迁移。

全部运行在 Cloudflare：Workers + SPA 静态资源 + SQLite Durable Objects，不需要服务器。

## 特性

- **多账号容量池**：每个账号独立配额、安全余量、外部已用容量；优先整文件存放，支持空间不足时跨账号分段。
- **浏览器直传 R2**：分片上传预签名 URL，文件不经过 Worker；并发 2 片，失败可续传/取消。
- **跨账号迁移**：服务端分片复制 + SHA-256 校验 + ETag/长度校验，提交索引后删除源对象；任务可暂停、恢复、取消。
- **完整文件管理**：文件夹、重命名、移动、回收站、收藏、最近、搜索、预览、分享链接（可设密码与有效期）、分段位置和缺失文件管理。
- **桶管理**：创建/连接已有桶、分配池开关、智能 CORS、生命周期、对象锁、自定义域名、事件通知、未完成分片清理、用量统计。
- **安全**：R2 凭据 AES-GCM 加密（绑定账号 ID）；HMAC 会话 Cookie；登录限流；Origin/CSRF 校验；CSP。

## 快速开始（本地）

要求：Node.js 20+、Cloudflare 账号、已开通 R2。

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入 ADMIN_PASSWORD 与至少 32 字符的 ENCRYPTION_KEY
```

开两个终端：

```bash
npm run dev:api   # wrangler dev，API 在 http://127.0.0.1:8787
npm run dev       # Vite 前端，/api 代理到 8787
```

首次进入会提示添加账号。需要准备：

1. **Cloudflare Account ID**（控制台右侧或 `wrangler whoami`）。
2. **R2 Access Key ID / Secret Access Key**：R2 → Manage R2 API Tokens → Create API Token，权限至少 Object Read & Write。
3. **API Token（可选）**：若要使用桶设置、域名、事件通知和用量统计，需要 Account API Token，权限为 Workers R2 Storage Read/Write 与 Account Analytics Read。
4. **桶**：可直接在网盘里创建，或连接账号中已有桶。建议使用 Standard 存储类并加入分配池。

添加账号后会触发一次容量扫描；扫描完成（`syncState=ready`）后该账号才会参与分配。

## 容量与分配规则

```
available = quotaBytes - safetyBytes
          - max(externalBytes, observedExternalBytes)
          - usedBytes - reservedBytes
usedBytes = SUM(普通可用对象 size + 8192)
          + SUM(可用分段实际 size + 8192)
```

- 分配按 `priority` 从小到大；只考虑启用、`syncState=ready` 的账号。先寻找可完整容纳文件的账号。
- 选中账号后取该账号 `inPool && storageClass === 'Standard'` 且未被设置任务锁定的桶。
- 允许跨账号拆分时，若没有单账号可完整容纳，按优先级使用多个账号的可用空间。每个独立分段另预留 8192 字节。
- 上传开始时原子预占所有分段容量；所有对象通过长度、ETag 和归属校验后，才提交一个逻辑文件并转为已用。取消/过期后逐段清理，再释放对应预占。
- 指定存储桶时仅使用该桶；关闭拆分后，总容量再大也必须由一个账号容纳整文件。

### 跨账号大文件

上传对话框默认启用「空间不足时允许跨账号拆分」。例如三个空账号分别配置 10 GB 配额、200 MB 安全余量，一个 20 GB 文件可以存为约 9.8 GB + 9.8 GB + 0.4 GB 的三个对象，在网盘里仍显示为一个文件。

- **上传/续传**：分段与 R2 multipart 分片是两层结构。每段是独立对象，内部使用分片直传；分片编号、文件偏移和上传 ID 持久化保存，重新选择同一原文件即可续传。
- **下载/预览**：分段文件由 Worker + Durable Object 流式重组，支持单范围 HTTP Range、HEAD、视频/音频/PDF 预览和文本预览；数据不整体载入内存。普通对象通过 R2 预签名 URL 下载。
- **请求用量**：分段下载/预览会调用 Worker 内容接口，并按所读取的分段产生 DO RPC；上传文件数据直接传到 R2。内容响应采用 `private, no-store`，主动文档类型使用 CSP sandbox。
- **文件管理**：重命名、目录移动、收藏、回收站、密码分享按一个逻辑文件处理。文件详情显示每段所在账号、桶、对象键和字节偏移。
- **迁移/复制**：可流式合并到容量充足的目标桶，并执行 SHA-256 校验。迁移提交后逐段删除源对象；提交后的取消会先完成当前文件的源分段清理，再停止后续文件。
- **元数据**：分段文件的 HTTP 元数据保存在逻辑索引中；分段对象保留用于恢复布局的系统元数据。迁移可把分段合并成一个对象；API 客户端还可在 `/api/transfers` 中指定 `storageClass` 或 `targetKey`。
- **缺失与恢复**：容量扫描保持分段索引，不把每段导入为重复文件。分段丢失或长度异常时，逻辑文件进入「缺失文件」；其余真实存在的分段仍计入各自账号用量。重新找回对象并同步可恢复完整文件，也可在缺失文件页面清理残留。
- **索引备份**：`/api/export` 的分页结果包含完整分段位置。仅凭 R2 系统元数据可重新发现布局与内容类型，但收藏、回收站状态、自定义 HTTP 元数据等以索引备份为准。
- **上限**：当前单个逻辑文件最多 `5 TiB - 5 GiB`，最多 512 个分段；实际受可用容量池限制。每段都是标准 R2 对象，可由其他 S3 工具访问，但整文件需按网盘索引重组。

API 客户端需在 `POST /api/uploads` 中明确传入 `allowSplit: true`。`GET /api/uploads` 和文件列表返回轻量摘要；`GET /api/uploads/:id`、`GET /api/files/:id` 返回完整布局。分段续传查询使用 `GET /api/uploads/:id/parts?segment=N`，完成每段后调用 `POST /api/uploads/:id/segments/N/complete`，最后调用整个上传的 `/complete`。

## 部署到 Cloudflare

```bash
npm run types          # 绑定变化后重新生成 worker-configuration.d.ts
npm run build
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ENCRYPTION_KEY
npm run deploy
```

首次部署会创建 `DriveCatalog` / `BackgroundJob` 两个 SQLite Durable Object（迁移 `v1`）。`wrangler.jsonc` 已配置 SPA 路由：静态资源走 Assets，`/api/*` 先交给 Worker。

部署前检查：

- `public/_headers` 的 CSP 允许 R2 S3 endpoint（`https://*.r2.cloudflarestorage.com`，含 jurisdiction 子域）。
- 桶 CORS 必须暴露 `ETag`，否则分片上传无法完成。可在桶设置 → CORS 使用“自动配置”。
- 免费账号容量与计费以 Cloudflare 当前政策为准；本项目的配额是**逻辑配额**，用于在多个账号间分配，不会改变 R2 实际限制。

### 预发环境

```bash
npx wrangler deploy --env staging
npx wrangler secret put ADMIN_PASSWORD --env staging
npx wrangler secret put ENCRYPTION_KEY --env staging
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 前端开发服务器 |
| `npm run dev:api` | 本地 Worker/DO |
| `npm run typecheck` | 前端 + Worker TypeScript 检查 |
| `npm test` | Vitest（Workers 运行时） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run check:deploy` | `wrangler deploy --dry-run` |
| `npm run deploy` | 构建并部署 |
| `npm run types` | 重新生成绑定类型 |

## 测试

`npm test` 使用 `@cloudflare/vitest-plugin` 在 Workers 运行时里验证容量分配、扫描和前端请求调度：

- 大文件跳过空间不足的高优先级账号，后续小文件回填该账号。
- 超过所有账号容量的文件被拒绝。
- 并发预占不会超卖配额。
- 多个页面/弹窗共享请求与轮询；页面隐藏、离线时暂停，失败时退避，退出登录清除内存缓存。
- 每批预取 8 片签名、仍并发上传 2 片；慢速上传和失败重试自动更新过期签名。
- 一次扫描处理 100 个未变化对象，保留回收站与元数据；HEAD 失败后重试不跳过文件。
- 实际 S3 协议与 SDK 链路：跨账号预占、multipart 分片编号、分段合并、字节一致性与跨分段 Range、分享令牌、取消/过期清理、缺失恢复、源账号移除后的任务检查点恢复。

## 请求用量优化

- **静态资源**：由 Workers Static Assets 直接提供，不占 Worker 动态请求额度。
- **共享状态**：账号、桶、后台任务、未完成上传合并到 `/api/status`，页面与弹窗共享内存缓存和在途请求；概览数据可复用为共享状态。
- **自适应刷新**：空闲每 120 秒刷新；有任务时传输中心每 5 秒、账号/桶每 10 秒、文件列表每 12 秒、文件页共享状态与概览每 15 秒刷新。页面隐藏或离线时暂停自动请求，返回后按数据时效更新。
- **手动刷新**：我的文件、最近文件、收藏、回收站统一保留一个「刷新文件」入口，核对当前列表对应的 R2 对象及分段后更新索引和共享状态。Cloudflare 外部删除的文件会移到「缺失文件」，已找回的对象可在缺失文件页面刷新恢复。权限或网络错误保留原状态并显示校验失败；运行中的文件跳过校验。
- **刷新调度**：手动刷新不复用此前挂起的后台请求，显示刷新进度和完成提示，连续点击共享同一次刷新。普通数据读取 30 秒超时，主动远端校验最多等待 5 分钟。自动轮询只读取索引，不重复核对 R2；外部新上传且尚未纳管的对象需通过账号容量同步发现。
- **变更刷新**：操作成功后仅刷新相关资源，短时间内的变更合并处理；下载、复制链接不触发无关列表刷新。
- **上传**：新会话省略空分片查询，续传仍核对 R2 的已上传分片。每批最多预取 8 片的 15 分钟签名，上传并发保持 2 片；签名过期或被拒绝时重新获取。单对象普通小文件新上传为 3 次 API，单对象 1 GiB 文件为 10 次（不含轮询、失败与重试）；跨账号分段另有逐段合并请求。文件数据直接传到 R2。
- **容量扫描**：未变化的对象只更新扫描标记，不重写整条文件记录；每步最多处理 100 个未变化对象或 6 个需 HEAD 校验的对象，并合并索引提交与进度汇报，减少 DO RPC 和 Alarm 调用。

单页面持续可见、无任务且不操作时，周期性 API 请求的估算：

| 页面 | 优化前 / 小时 | 优化后 / 小时 |
| --- | ---: | ---: |
| 概览 | 240 | 30 |
| 我的文件 | 660 | 60 |
| 存储账号 | 600 | 30 |
| 存储桶 | 420 | 30 |
| 传输中心 | 960 | 30 |
| 我的分享 | 240 | 30 |

首次加载、页面切换与实际操作另计。Worker 请求、DO RPC/Alarm、数据库读写和 R2 操作分别有自己的用量统计，减少前端请求不会改变各服务的免费额度。

主动文件刷新通过 `POST /api/files/refresh` 完成（列表参数放在查询字符串中），返回最新列表、共享状态、校验计数和失败信息。它会按当前页文件/分段数量产生 R2 HEAD 读取和 DO RPC；没有整文件内容下载，也不会删除远端对象。

## 目录结构

```
worker/
  index.ts            REST 路由、会话、预签名、静态资源
  catalog.ts          DriveCatalog：索引、容量账本、预占、迁移提交、扫描
  jobs.ts             BackgroundJob：scan/transfer/delete/upload-cleanup 状态机
  r2.ts               S3 客户端、凭据解析、对象操作
  bucket-settings.ts  桶设置、域名、事件、统计（Cloudflare API）
  crypto.ts           AES-GCM / HMAC / 哈希
  content.ts          分段内容响应、Range、HEAD 与条件请求
shared/               前后端共享类型与路径/容量工具
src/                  React SPA（页面、组件、上传队列、样式）
test/                 Vitest 测试
public/               favicon 与 _headers（CSP）
```

## 安全说明

- `ENCRYPTION_KEY` 至少 32 字符，用于加密 R2 凭据和签名会话；更换后旧凭据与会话失效。
- 会话 Cookie 为 `HttpOnly; SameSite=Strict`，HTTPS 下自动加 `Secure`。
- 登录接口按 IP 限流（15 次 / 15 分钟）。
- 分享链接可设密码与过期时间；普通对象使用短期 R2 签名，分段文件使用绑定文件版本的 HMAC 内容令牌。
- 不要提交 `.dev.vars`、`.env` 或任何真实密钥。
