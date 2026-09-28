# ehon2 · Yomikiki Books

私有单用户家庭绘本阅读助手。上传日文绘本封面与内页照片，AI 完成文字识别、
阅读顺序、相对坐标框、日语阅读辅助、中英翻译、中文亲子讲解与多语 TTS。

## 技术栈

- 前端：React 19 + Vite 6 + TypeScript + Tailwind CSS 4
- 后端：Node 22 + Hono + Zod（同一容器内同时提供 API 与前端静态文件）
- 数据：SQLite 文件（`node:sqlite`，WAL 模式）+ 本地 `media/` 目录
- AI：OpenAI（服务端调用：Vision 分析 + TTS）
- 部署：Docker 单镜像 → GitHub Actions 自动构建 → GHCR → Zeabur / VPS

## 快速开始（本地开发）

```bash
pnpm install

# 1. 生成登录密码哈希，填入 .env
node scripts/hash-password.mjs
cp .env.example .env   # 填入 AUTH_PASSWORD_HASH 等真实值
chmod 600 .env

# 2. 启动（后端 :3000 + 前端 :5173，/api 已代理）
pnpm dev
# 访问 http://localhost:5173
```

常用命令：

```bash
pnpm typecheck   # 全工作区类型检查
pnpm build       # 依次构建 shared → web → server
pnpm --filter @ehon2/server test   # 单元 + SQLite 集成测试
```

## Docker 运行

```bash
cp .env.example .env && chmod 600 .env   # 填好必填变量
docker compose up -d --build
# 访问 http://localhost:3000（单容器同源：/api/* 走后端，其余走前端）
docker compose logs -f app
```

数据持久化：`./data` 目录挂载到容器的 `/data`（SQLite 文件 + `media/`）。

## 部署到 Zeabur

1. 把代码 push 到 GitHub（仓库 `5566-maker/ehon2`）后，
   Actions 会自动构建并推送镜像：`ghcr.io/5566-maker/ehon2:latest`
2. 在 GitHub Packages 把镜像设为 **Public**（否则 Zeabur 无法免鉴权拉取）
3. Zeabur 新建 Service → 选择该镜像，配置：
   - 环境变量（必填）：`OPENAI_API_KEY`、`AUTH_USERNAME`、`AUTH_PASSWORD_HASH`、`SESSION_SECRET`
   - 环境变量（内页识别）：`GOOGLE_VISION_API_KEY`（不设则服务照常启动，但内页识别会报错）；
     `OCR_PROVIDER=google`（默认）；`OPENAI_VISION_MODEL=gpt-5.6-luna`（enrichment 模型，推荐），
     `OPENAI_ENRICHMENT_FALLBACK=gpt-5.6-sol`（enrichment 失败时自动重试一次，可选）
   - Volume：挂载到 `/data`（持久化数据库与媒体）
   - 端口：3000（`PORT` 环境变量可改）

详见 [docs/DOCKER_ADAPTATION.md](docs/DOCKER_ADAPTATION.md)。

## AI 识别链路（内页）

1. **Google Vision OCR**（`DOCUMENT_TEXT_DETECTION`）：识别文字 + 精确坐标，按段落切分为
   `ocr_001`、`ocr_002`…… 等稳定片段。结果缓存进 `pages.ocr_json`，换 enrichment 模型或 prompt
   时只重跑 OpenAI，不再花 OCR 的钱；只有 `forceOcr=true` 才会重新调用 Google。
2. **OpenAI enrichment**（`OPENAI_VISION_MODEL`，推荐 `gpt-5.6-luna`；`gpt-4o` 也可用）：看图 +
   OCR 片段，把片段按 `ocr_ids` 分组成阅读块，做注音/翻译/讲解/生词。**不返回坐标**，引用了不
   存在的 OCR id 会直接报错。
   - 模型兼容性：`gpt-5.6-luna` / `gpt-5.6-sol` 不接受显式的 `temperature` 参数（带上会 HTTP 400），
     服务端对这类模型会自动省略该字段；此前的 400 报错就是这个原因，现已修复。
   - 可选 `OPENAI_ENRICHMENT_FALLBACK=gpt-5.6-sol`：主模型因 OpenAI 侧错误或返回非法数据失败时，
     自动用该模型重试一次（Google Vision OCR 不重试；引用未知 OCR id 等本地校验错误不重试）。
3. 服务端把 `ocr_ids` 映射为每个块的多个精确点击区域（`text_blocks.regions_json`），并保留
   各区域的并集 bbox 做旧数据兼容。阅读器一个块可点多个区域，编辑器可查看/增删/数值编辑区域，
   还能叠加显示 OCR 原始片段做 debug。

## 使用流程

1. `/login` 登录（单用户，Cookie 会话）
2. 书架 → 新建绘本 → 上传封面 → AI 解析封面（可手工修正标题/作者）
3. 在「整理」页上传内页照片（手机拍照为主，HEIC 自动转 JPEG）
4. 逐页或批量 AI 识别 → 校对文字块、坐标框、生词
5. 在阅读器点图上的文本框，听日语/中文/英文朗读，看翻译和亲子讲解

## 仓库结构

```
apps/server/      Hono API（Node），含 SQLite、文件存储、OpenAI 调用
apps/web/         React 前端（构建产物由 server 同源提供）
packages/shared/  前后端共享类型、Zod schema、媒体 key 工具
migrations/       SQLite 迁移（服务启动时自动执行）
scripts/          运维脚本（hash-password.mjs 等）
docs/             设计文档（Docker 适配说明）
.github/workflows/  CI：构建并推送镜像到 GHCR
```

## 需求文档

原始需求（Cloudflare 版，供参考，Docker 适配差异见 docs/DOCKER_ADAPTATION.md）：
`~/workspace/user/files/Yomikiki_Technical_Spec.md`、
`~/workspace/user/files/Yomikiki_Codex_Implementation_Prompt.md`

## 已知限制

- AI 识别（封面/内页）与 TTS 需要真实的 `OPENAI_API_KEY`；竖排、艺术字体的识别率需用 5–10 页真实绘本样本验证
- HEIC 转码依赖 iPhone Safari 的 canvas 解码能力，需真机验证
- 单用户设计：同一账号多设备登录共享会话（退出会踢掉所有会话）
