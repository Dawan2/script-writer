# 虎鲸｜剧本出海工作站

这是“虎鲸｜剧本出海工作站”的 Web 产品仓库。根目录承载站点工程，`Agents/` 保持为可独立打开、可独立运行的 Claude Code Agent 子项目。

## 目录

```text
.
├── apps/web          # Next.js 前端
├── apps/api          # FastAPI 后端
├── Agents            # 独立 Claude Code Agent 项目
├── docs/adr          # 架构决策记录
└── tmp               # 产品需求、阶段提示词和 UI 概念图
```

## 本地启动

首次安装：

```bash
npm install
cd apps/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

开发模式启动前后端：

```bash
npm run dev
```

该命令保留前端热更新，但 API 不会因源码保存而自动重启，适合执行故事梗概、试稿和完整剧本等长任务。修改 API 后，请在没有进行中的任务时手动重启该命令。

仅在不运行 Agent 长任务、且需要 API 热重载时使用：

```bash
npm run dev:watch
```

API 热重载会先停止现有 API 进程；它会中断该进程托管的 Agent 子任务。因此不要在任务运行期间使用或保存触发该模式重载的 API 代码。

服务器使用生产模式：

```bash
npm run build
npm run start
```

生产服务仍应使用 `npm run build` 和 `npm run start`，不要使用带有开发服务器和热更新能力的 `npm run dev`。

访问：

- Web: http://127.0.0.1:3000/workspace
- Login: http://127.0.0.1:3000/login
- API health: http://127.0.0.1:8000/health

## 检查

```bash
npm run check
```

该命令会执行：

- Web TypeScript 检查
- FastAPI Python 编译检查
- `Agents` 子项目的原有 `npm run check`

## Agent 子项目

`Agents/` 仍然是完整 Claude Code Agent 项目。可以单独进入后手动运行：

```bash
cd Agents
npm run check
```

站点后端后续只应通过受控 runner 在 `cwd=Agents` 下调用 Agent，不应把 Agent scripts 合并进根目录。

## 当前可用账号

本地开发已创建：

- `admin / 1`
- `demo / orca-demo`

新增用户：

```bash
npm run api:create-user -- --username alice --password orca-demo --display-name Alice --role user
```

导入已有 Agent workspace：

```bash
npm run api:import-workspaces -- --owner admin
```

## 当前阶段能力

- 登录、退出登录。
- 普通用户和 admin 的基础鉴权。
- 项目列表、搜索、置顶、重命名、软删除。
- 从 `Agents/workspaces` 读取项目阶段文件。
- Markdown 的预览、编辑、源码三态切换。
- 保存 Markdown 并记录文件版本。
- 新建剧本项目，上传 `pdf/docx/txt/md`，并调用 `Agents` 中的 `project_init`。
- [OpenClaw 批量任务 API](docs/OpenClaw批量任务API.md)：通过 HTTPS API 创建批量任务。
