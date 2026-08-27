# zdebug

一个零依赖的 Claude Code 本地日志查看器，用于查看本地 Claude 会话日志。

## 能力范围

- 根据项目目录推导 Claude Code 日志目录：`~/.claude/projects/<project-id>`。
- 列出 `.jsonl` 会话文件，支持通过 `?sessionid=<id>` 默认打开指定会话。
- 支持通过后端生成的 manifest 按任务归属显式限制可读日志，并通过 `?logid=<id>` 精确打开指定 job 日志。
- 解析用户消息、AI 回复、思考内容、工具调用、工具结果与原始 JSON。
- 用纯 Node.js HTTP server 提供 Web 调试界面，不依赖 npm 私有包。

## 使用

```bash
node tools/zdebug/bin/zdebug.mjs --serve --port 4301 --project /path/to/project
```

也可以直接指定日志目录：

```bash
node tools/zdebug/bin/zdebug.mjs --serve --port 4301 --log-dir ~/.claude/projects/-path-to-project
```

工作台集成模式使用显式日志清单，清单外的全局会话不会被枚举：

```bash
node tools/zdebug/bin/zdebug.mjs --serve --port 4301 --project /path/to/project \
  --log-manifest /path/to/agent_job_32.json --selected-log-id job-32
```

## SessionID 反馈排查

用户提供 Claude Code `sessionID` 或 ZDebug 链接时，只从本地代码、数据库和日志文件取证，不打开浏览器。先确定一次具体任务，再读与该任务对应的日志和工作区文件；不要把同一阶段复用的 session 误当成单次执行。

- ZDebug URL 的 `logid=job-<任务号>` 对应 `agent_jobs.id`，是本次执行的首选定位键；`sessionid` 对应 `agent_jobs.claude_session_id`，同一 session 可能关联多次任务。`/zdebug/<端口>/` 中的端口是临时服务端口，不携带项目归属。
- 站点运行日志的权威路径是 `agent_jobs.raw_log_path`，新任务默认写入 `data/zdebug/jobs/agent_job_<任务号>.jsonl`。ZDebug 展示的正是这个 JSONL；`data/zdebug/manifests/agent_job_<任务号>.json` 仅在调试服务运行时作为任务日志清单，可用于交叉验证，不能作为唯一历史依据。
- Claude Code 原始会话记录位于 `~/.claude/projects/<由 Agents 绝对路径编码的目录>/<sessionID>.jsonl`。编码规则见 `tools/zdebug/src/logs.mjs` 的 `projectIdFromPath`；站点从 `Agents/` 目录启动 Claude，故先按该目录推导，未命中再在 `~/.claude/projects` 中按文件名精确查找。