# ehon2 · Yomikiki Books

私有单用户家庭绘本阅读助手。上传日文绘本封面与内页照片，AI 完成文字识别、
阅读顺序、相对坐标框、日语阅读辅助、中英翻译、中文亲子讲解与多语 TTS。

## 技术栈

- 前端：React 19 + Vite 6 + TypeScript + Tailwind CSS 4
- 后端：Node 22 + Hono + Zod（同一容器内同时提供 API 与前端静态文件）
- 数据：SQLite 文件（`node:sqlite`，WAL 模式）+ 本地 `media/` 目录
- AI：OpenAI（服务端调用：Vision 分析 + TTS）
- 部署：Docker 单镜像 → GitHub Actions 自动构建 → GHCR → Zeabur / VPS

## 快速开始（本地）

```bash
pnpm install
cp .env.example .env   # 填入真实值
node scripts/hash-password.mjs   # 生成 AUTH_PASSWORD_HASH 后填入 .env
pnpm dev               # 前端 :5173 + 后端 :3000（见各包 README）
```

或直接用 Docker：

```bash
cp .env.example .env && chmod 600 .env
docker compose up -d --build
# 访问 http://localhost:3000
```

## 部署到 Zeabur

详见 [docs/DOCKER_ADAPTATION.md](docs/DOCKER_ADAPTATION.md)：
镜像 `ghcr.io/5566-maker/ehon2:latest`（push 到 main 后由 Actions 自动构建），
填好环境变量，挂载 volume 到 `/data`，暴露 `PORT`（默认 3000）即可。

注意：首次推送后去 GitHub Packages 把镜像设为 Public，否则 Zeabur 无法免鉴权拉取。

## 仓库结构

```
apps/server/      Hono API（Node），含 SQLite、文件存储、OpenAI 调用
apps/web/         React 前端（构建产物由 server 同源提供）
packages/shared/  前后端共享类型
migrations/       SQLite 迁移（服务启动时自动执行）
scripts/          运维脚本（密码哈希生成等）
docs/             设计文档（Docker 适配说明）
.github/workflows/  CI：构建并推送镜像到 GHCR
```

## 需求文档

原始需求（Cloudflare 版，供参考，Docker 适配差异见 docs/DOCKER_ADAPTATION.md）：
`~/workspace/user/files/Yomikiki_Technical_Spec.md`、
`~/workspace/user/files/Yomikiki_Codex_Implementation_Prompt.md`
