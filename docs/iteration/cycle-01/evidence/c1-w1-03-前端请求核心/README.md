# `C1-W1-03` 前端请求核心 · 验收证据

| 项 | 值 |
| --- | --- |
| 实现规格 | `cursor/w2-spec-c1-w1-03-058e @ 41928cb` 的 [W2 C1-W1-03 实现规格](../../W2-C1-W1-03-实现规格.md)（下称「规格」），验收出处为其 §6 的十四条 |
| 代码基线 | `main @ abb779e` + 13（`cursor/w1-13-web-test-harness-058e @ f252f8b`）+ 02（`cursor/w2-c1-w1-02-error-contract-058e @ 58f1aaf`），合并点 `bd5955b` |
| 本槽分支 | `cursor/w2-c1-w1-03-058e` |

IN-1（`b53b6c5`）在本环境的远端取不到，未并入。本包与它的三处改动（搜索防抖、空列表提示文案、错误横幅 `role="alert"`）零文件交集，规格 §0.1 的其余实测项在合并点上逐条复核一致。

根 `package.json` 的 `scripts` 冲突按规格勘误 E-03-2 的并集口径解决：`check:web` 取 13 的 `cd apps/web && npm run check`（含裸 `fetch` 检查），`check:api` 与 `check:errors` 取 02 的注册表校验，`test` 保留 13 的 `node scripts/run-all-tests.mjs`。

---

## 1. 两条命令的改前改后

| 命令 | 改前（合并点 `bd5955b`） | 改后 |
| --- | --- | --- |
| `npm run test:web` | 37 项 **2 失败**（都在 `tests/examples/api-client-contract.test.ts`） | **74 项 0 失败**，18 个测试文件 |
| `npm run check:web` | 通过，「检查通过：**128** 个文件中没有绕过网络出口的 `fetch` 调用」 | 通过，「检查通过：**131** 个文件中没有绕过网络出口的 `fetch` 调用」 |

改前的两项失败（规格勘误 E-03-1）：

```
FAIL tests/examples/api-client-contract.test.ts > 服务端的中文错误文案原样抛给调用方
  expected [Function] to throw error including '没有该项目的查看权限' but got '这次请求的返回内容无法读取。'
FAIL tests/examples/api-client-contract.test.ts > 响应体畸形时给出带状态码的兜底文案
  expected [Function] to throw error including '请求失败（500）' but got '这次请求的返回内容无法读取。'
```

修正方式：夹具改成 02 定稿的信封形状，断言改按错误码。三条用例一条没删、一条没跳过；第三条的标题改为「响应体畸形时给出可报给客服的兜底提示」，因为 02 之后兜底文案里不再出现 HTTP 状态码。

## 2. 检索类判据的改前改后

| 判据 | 改前 | 改后 |
| --- | --- | --- |
| `rg -c 'fetch\(' apps/web/src/lib/api-client.ts apps/web/src/lib/admin-api.ts`（AT-08） | 65 + 61 = 126 | 0（两个文件均无命中） |
| `rg -n 'indexOf("\{")' apps/web/src`（AT-05） | 1 处（`app/workspace/page.tsx`） | 0 处 |
| `allowed-network-egress.json` 的文件项（AT-08） | 3 条（含两个接口模块） | 2 条：`request-core.ts`、`server/backend.ts` |
| `git diff --name-only -- 'apps/web/src/app/api/**/route.ts'`（AT-08） | — | 只有 1 个文件：`api/agent/jobs/[jobId]/stream/route.ts` |

## 3. 十四条验收与用例对应

`npm run test:web` 的 74 项里，本包新增 37 项在 `tests/request/**`。

| # | 用例位置与名称 |
| --- | --- |
| AT-01 | `budget.test.ts`：每一档的浏览器预算都大于代理层预算，共 11 行有限值 / 有后端子进程上限的行，代理层预算都大于该上限 / 每个覆盖档在 `api-client.ts` 里有且只有一个声明点 |
| AT-02 | `timeout-and-cancel.test.ts`：读请求在读档到期时中断，并给出等待太久的说明 / 阶段保存按覆盖档等待，到期前不中断、到期即中断（两条都再推进 60 秒断言调用次数仍为 1） |
| AT-03 | `unmount-cancel.test.tsx`：响应返回前卸载：请求被取消，回写函数一次都没被调用 |
| AT-04 | `budget.test.ts`：按浏览器声明的预算减 5 秒 / 头缺失、非数字、零或负数都按读档 / 声明值极小时不低于下限 |
| AT-05 | `failure-envelope.test.ts`：按错误码分支：命中与不命中各一条；`outlets.test.ts`：前端不再对着错误文案做字符串匹配 |
| AT-06 | `retry.test.ts`：读请求连续遇到 502：第 2、3 次调用发生在 +500 ms 与 +1500 ms，没有第 4 次 / 一次响应都没拿到时同样只退避两次 / 拿到 429 或 4xx 时不重试 / 写操作在四种传输层失败下都只发一次，带幂等键也不重发 |
| AT-07 | `batch-failures.test.tsx`：3 项里 2 项失败：每项一条说明，成功项按实际计数表述 / 删除时一项失败，其余项照样删掉 |
| AT-08 | `outlets.test.ts`：两个业务接口模块里一次 `fetch` 都不剩 / 出口清单只留两个文件，且不含这两个接口模块；另见本文 §2 的清单与 `git diff` 判据 |
| AT-09 | `failure-envelope.test.ts`：每个请求都带上浏览器生成的追踪号 / 失败时的追踪号取代理层复制回来的那一个 / 代理层没复制追踪号时沿用浏览器这次生成的号；`proxy.test.ts`：浏览器加的三个头都带到后端 / 后端响应头里的追踪号被复制回浏览器 |
| AT-10 | `failure-envelope.test.ts`：一次响应都没拿到时给出连不上的说明，追踪号带 `web-` 前缀；`proxy.test.ts`：后端连不上：503 加连不上的信封 / 代理层预算到期：504 加等待太久的信封，且比浏览器预算先到期 |
| AT-11 | `client-copy.test.ts`：三条客户端错误码的文案与注册表逐字一致 / 注册表里的客户端错误码没有一条缺镜像 |
| AT-12 | `npm run test:web`：74 项 0 失败，总项数由 37 增至 74，只增不减 |
| AT-13 | `budget.test.ts`：预算表没给进展流任何有限值 / 进展流路由显式声明不设超时；`proxy.test.ts`：声明不设超时的请求不排任何预算定时器 |
| AT-14 | `npm run check:web` 通过；`entry-points.test.ts`：`AgentJob` 能读到错误码、错误分类与是否可重试 |

四个接入位另有三条用例：幂等键只透传（给了写进请求头、没给不出现）、会话失效只广播（只有登录态失败通知处理器）、连接状态只广播（连不上一次、恢复一次）。取消与超时分名另有一条：调用方取消时抛的是 `RequestCancelled`，不带错误码，也不广播连接状态。

## 4. 慢接口清点（规格 §7 第 8 条）

```
rg -n 'subprocess\.run\(' -A 8 apps/api/app --glob '!tests' | rg 'timeout='
```

全仓 37 处 `subprocess.run`，26 处在调用点显式写了 `timeout=`。浏览器可直接触发且同步执行的 8 个接口已按规格 D2 逐一登记覆盖档，后端调用点如下：

| 覆盖档 | 接口 | 后端调用链与子进程调用点 | 后端上限 |
| --- | --- | --- | --- |
| `stageSave` | `PUT /projects/{id}/files/{stage}` | `write_stage_file` → `write_structured_stage_file`（`workspace_service.py:3298`）→ `run_stage_validation`（`memory_sync_service.py:1028`） | 300 s |
| `stageApprove` | `POST /projects/{id}/stages/{stage}/approve` | `approve_new_stage`（`workspace_service.py:1362`） | **60 s**（见下方勘误） |
| `projectReinitialize` | `POST /projects/{id}/reinitialize` | `_run_distribution_brief_tool`（`workspace_service.py:760`）+ `resolve_distribution_locale_contract`（`:1081`） | 60 + 30 s |
| `distributionBriefSave` | `PUT /projects/{id}/distribution-brief` | `_run_distribution_brief_tool`（`workspace_service.py:760`） | 60 s |
| `outlineTitleSync` | `PUT /projects/{id}/outline-title` | `_run_script_title_rename`（`workspace_service.py:2353`） | 60 s |
| `projectReopen` | `POST /projects/{id}/reopen` | `reopen_project` → `get_memory_status` → `run_memory_tool(timeout=60)`（`memory_sync_service.py:294`） | 60 s |
| `distributionBriefRead` | `GET /projects/{id}/distribution-brief` | `distribution_brief_for_project` → `resolve_distribution_locale_contract`（`workspace_service.py:1081`），仅旧布局且已填目标国家时触发 | 30 s |
| `projectMemoryRead` | `GET /projects/{id}/memory` | `get_memory_status` → `run_memory_tool(timeout=60)`（`memory_sync_service.py:294`） | 60 s |
| 上传默认档 | `POST /projects`（新建项目） | `create_project_from_source_path`（`workspace_service.py:3766`） | 180 s |

**勘误 E-03-8**：规格 D2 把「阶段审批」的后端上限记为 300 s，实测是 **60 s**——审批端点走的是 `approve_new_stage`（`timeout=60`），300 s 的 `run_stage_validation` 只在阶段保存路径上；`approve_stage_memory`（`memory_sync_service.py:1075`）当前没有调用方。预算值保持规格的 330 s / 325 s 不动（更宽只会多等，不会把合法的慢审批判成失败），代码里登记的后端上限改为实测的 60 s，AT-01 第二项的不变量仍成立。

规格 D2 要求实现槽自己确认的两条管理台命中：

- Agent 进化执行（`system_agent_evolution_service.py:515`，90 s）**不在请求路径上**：它只被 `run_system_evolution_analysis` 与 `run_system_evolution_execution` 调用，而这两个函数在 `routers/admin.py:1228`、`:1242`、`:1303` 全部走 `BackgroundTasks`。因此不需要覆盖档。
- 剧本库文档提取（`script_library_service.py:370/390/400`，120 s / 180 s）**在请求路径上**：`POST /admin/script-library/scripts` 同步调用 `create_uploaded_script` → `extract_script_text`。单个文件按上传档（浏览器 240 s / 代理层 235 s）已覆盖，但该接口一次最多收 20 个文件，逐个提取的累计耗时可能超过上传档——这是后端预算本身的问题，登记为余量（归 `C1-W1-11`、`36`、`42`），本包不改后端也不新增覆盖档，否则会破坏 AT-01 第三项的「覆盖档只在 `api-client.ts` 声明」判据。

## 5. 本包登记的余量

| # | 内容 | 归属 |
| --- | --- | --- |
| R-03-1 | 管理台上传剧本一次最多 20 个文件，逐个提取的累计耗时可能超过上传档 | 后端预算：`C1-W1-11`、`36`、`42` |
| R-03-2 | 逐项失败当前只有文案没有错误码（`batch_tasks.py:153` 回填 `str(exc.detail)`），批量呈现因此按文案展示 | `C1-W1-09` |
| R-03-3 | 旧版工作区布局的阶段校验失败仍把子进程输出拼进句子（`memory_sync_service.py:1051`），未进信封 `details` | 规格勘误 E-03-7，`02` / W3 |
| R-03-4 | 同路径读请求合并未做，理由见规格 D2 第 3 条 | W3 收口 |

## 6. 未取得的证据

规格 §7 的第 4、5、6 条要求停掉 API 后走查界面并截图（含带 `web-` 前缀追踪号与后端日志的对照）。本槽只有命令行环境，未启动 Web 与 API 双进程，这三条人工走查未做。其中「连不上时用户看到什么」「追踪号带 `web-` 前缀」「批量 3 选 2 失败的分项呈现与成功计数」三件事已分别由 `failure-envelope.test.ts`、`proxy.test.ts`、`batch-failures.test.tsx` 自动断言，缺的是界面截图与后端日志查号的人工对照。
