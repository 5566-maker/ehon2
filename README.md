# ehon2 · Yomikiki Books

私有单用户家庭绘本阅读助手。上传日文绘本封面与内页照片，AI 完成文字识别、
阅读顺序、相对坐标框、日语阅读辅助、中英翻译、中文亲子讲解与多语 TTS。

## 技术栈

- 前端：React 19 + Vite 6 + TypeScript + Tailwind CSS 4
- 后端：Node 22 + Hono + Zod（同一容器内同时提供 API 与前端静态文件）
- 数据：SQLite 文件（`node:sqlite`，WAL 模式）+ 本地 `media/` 目录
- AI：OpenAI（服务端调用：Vision 分析）；TTS 默认走自建 Kokoro（Zeabur 内网），OpenAI TTS 仅作 fallback
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

## TTS（朗读）链路

1. **Kokoro**（默认，`TTS_PROVIDER=kokoro`）：调用同一 Zeabur 项目内网的 Kokoro FastAPI
  （`KOKORO_BASE_URL`，默认 `http://kokoro-fastapi-cpu.zeabur.internal:8880`），`POST /v1/audio/speech`
   取 MP3。默认 voice：日语 `jf_alpha`、中文 `zf_xiaobei`、英语 `af_heart`，可用
   `KOKORO_JA_VOICE` / `KOKORO_ZH_VOICE` / `KOKORO_EN_VOICE` 覆盖。
2. **OpenAI fallback**：Kokoro 连接失败/超时/5xx/返回非法音频时，自动用
   `OPENAI_TTS_MODEL`（默认 `gpt-4o-mini-tts`）重试一次；空文本、超长文本等本地校验错误不重试。
3. 缓存：沿用现有音频缓存，Kokoro 的缓存 voice 会记为 `kokoro/<voice>`，与 OpenAI 缓存互不干扰，
   旧的 OpenAI 缓存继续有效。
4. 日语朗读输入优先用文本块的假名注音（`reading_text`），避免汉字被 TTS 引擎误判成中文发音。
5. **设置页**：登录后点右上角 ⚙️ 可进 `/settings`，用下拉菜单自由选择每种语言的 Kokoro
   声音（日/中/英各 5/8/19 个可选）和语速（0.5–2.0，0.1 步长）。页面设置存 SQLite
   `settings` 表，优先级高于环境变量；换声音/语速不影响已缓存的旧音频（缓存 key
   本来就含 voice 和 speed）。设置页底部还有「修改密码」：弹窗输入当前密码和新密码
   （最短 8 位），新哈希写入 `settings.auth.password_hash`（覆盖 `AUTH_PASSWORD_HASH`
   的登录校验），成功后删除全部 session 并跳回登录页。错误输入的当前密码同样计入
   登录限流。

Zeabur 环境变量（追加）：

```env
TTS_PROVIDER=kokoro
KOKORO_BASE_URL=http://kokoro-fastapi-cpu.zeabur.internal:8880
KOKORO_TTS_MODEL=kokoro
# KOKORO_JA_VOICE=jf_alpha
# KOKORO_ZH_VOICE=zf_xiaobei
# KOKORO_EN_VOICE=af_heart
OPENAI_TTS_MODEL=gpt-4o-mini-tts   # 仅作 fallback，保留
# 语速（0.5–2，默认 1）：分语言覆盖优先于全局
TTS_SPEED_JA=1.2
TTS_SPEED_ZH=1.2
# TTS_SPEED=1.15
# TTS_SPEED_EN=1
```

语速优先级：朗读请求里显式传的 `speed` ＞ 设置页面的语速 ＞ `TTS_SPEED_JA/ZH/EN` ＞ `TTS_SPEED`（默认 1）。
改语速后旧缓存按原语速保留，新语速会重新生成。
声音优先级：朗读请求里显式传的 `voice` ＞ 设置页面的声音 ＞ `KOKORO_JA_VOICE/ZH_VOICE/EN_VOICE` ＞ 内置默认。

## 可靠性说明

- **登录限流**：`POST /auth/login` 按客户端 IP 限流，5 分钟内失败 5 次后返回 `429 RATE_LIMITED`；
  成功登录会清零该 IP 的失败计数。只限登录接口，不影响会话/登出。
- **识别防重**：内页识别进行中（`processing`）时再请求会返回 `409 PAGE_ALREADY_PROCESSING`。
  服务启动时会自动把卡在 `processing` 超过 `PROCESSING_STALE_MINUTES`（默认 15 分钟）的页面/任务
  置为 `failed`（比如上次重启时正好在识别），可直接重试。
- **超时**：`GOOGLE_VISION_TIMEOUT_MS`（默认 30000ms）中止挂起的 Google Vision 请求；
  `OPENAI_TIMEOUT_MS`（默认 60000ms）限制 OpenAI API 调用时长（SDK 默认是 10 分钟）。
- **批量上传**：先校验+处理全部文件，再一次性落盘；中途任何一张失败都不会留下半批数据，
  存储写入失败会回滚整批（数据库行 + 已写文件）。
- **绘本状态**：`processing`（有页面在跑）/ `ready`（全部页面 ready）/ `failed`（有页面失败且无在跑任务）
  由页面状态推导，不再"粘"在 failed 上——重试成功后绘本会自动回到 ready。
- 删除文本块/页面、编辑文本、重新识别都会清理其关联的音频缓存文件，不留孤儿 MP3。

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
