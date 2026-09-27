# Docker / VPS 适配说明

原需求文档（`~/workspace/user/files/Yomikiki_Technical_Spec.md` 与
`Yomikiki_Codex_Implementation_Prompt.md`）按 Cloudflare Workers + D1 + R2 设计。
本项目改为 **Docker 单容器 + VPS / Zeabur** 部署，以下是对应的设计变更。
未列出的部分以原两份文档为准。

## 架构映射

| 原设计 (Cloudflare) | Docker 版 |
|---|---|
| Cloudflare Worker + Hono | Node 22 + Hono（`@hono/node-server`），同一容器 |
| D1（SQLite 方言） | SQLite 文件（`node:sqlite`，Node 22 内置），路径 `${DATA_DIR}/ehon2.db` |
| R2 私有桶 | 本地目录 `${DATA_DIR}/media/...`，经受保护的 API 路由提供访问 |
| Worker bindings / secrets | 环境变量（见 `.env.example`） |
| wrangler.toml | `Dockerfile` + `docker-compose.yml` |
| wrangler migrations | 服务启动时自动执行的 SQL 迁移（`migrations/*.sql`，幂等） |
| Queues（规划中） | 进程内轻量任务队列（单用户足够） |

## 关键决策

1. **单容器**：API 与前端静态文件同源（`GET /api/*` 走 Hono，其余走 `deploy/public` 的 SPA fallback）。
   好处：无 CORS 问题、Zeabur 只需暴露一个端口（`PORT`，默认 3000）。
2. **SQLite 用 WAL 模式**：`PRAGMA journal_mode = WAL;`，读写并发更稳。
3. **密码哈希**：`node:crypto` 的 scrypt（零原生依赖），格式
   `scrypt$N$r$p$<salt-b64>$<hash-b64>`。`scripts/hash-password.mjs` 负责生成。
4. **图片处理**：sharp（Docker 内可用完整 Node 生态）。
   EXIF 自动旋转、最长边 1600px、转 WebP。HEIC 仍以前端转码为主（见原文档）。
5. **会话**：与原文档一致（HttpOnly + Secure + SameSite=Lax Cookie，服务端存 token 的 SHA-256）。
6. **`*_image_key` / `audio_key`**：语义不变，但值为相对文件路径（如 `media/books/<id>/p01.webp`），
   以 `${DATA_DIR}` 为根。
7. **TTS 缓存键**：`(block_id, language, voice, speed, text_hash)`，`text_hash` 必须参与
   （原文档实现 Prompt 漏写，以技术规范为准）。

## 部署

### 本地 / VPS（docker compose）

```bash
cp .env.example .env   # 填入真实值，chmod 600 .env
docker compose up -d --build
```

数据持久化在 named volume `ehon2-data`（挂载到 `/data`）。

### Zeabur（从镜像部署）

1. GitHub 仓库 Settings → Actions → 确认 workflow 已跑通；
   首次推送后到 GitHub 的 Packages 页面把 `ehon2` 镜像设为 **Public**（否则 Zeabur 拉取需要鉴权）。
2. Zeabur 新建 Service → Deploy from Image → `ghcr.io/5566-maker/ehon2:latest`。
3. 在 Variables 中填入 `.env.example` 里的必填项（`OPENAI_API_KEY`、`AUTH_USERNAME`、
   `AUTH_PASSWORD_HASH`、`SESSION_SECRET`），`DATA_DIR=/data`。
4. 添加 Volume，挂载路径 `/data`（持久化 SQLite + 媒体文件）。
5. 端口使用 `PORT`（默认 3000），绑定域名，开启 HTTPS。

### 备份

定期备份 volume 内容（`/data/ehon2.db*` + `/data/media/`）。SQLite 备份前建议
`VACUUM INTO` 或直接拷贝 WAL 模式下的 db/shm/wal 三个文件（停机拷贝最稳妥）。
