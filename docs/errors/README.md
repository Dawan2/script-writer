# 错误码目录（SPEC-03 注册表生成物）

> **生成物，请勿手改**：本页由 `scripts/gen-error-docs.ts` 从 `src/app/errors/registry.ts` 生成；修改文案请改注册表后运行 `npm run gen:errors`。CI 的 `npm run lint:errors` 会拦截漂移与手改。

所有用户可见错误均为三段式（发生了什么 / 原因 / 怎么办）+ 本目录锚点链接，
由 `fail(code, ctx)` 抛出、CLI 顶层 catch 统一渲染。

## 退出码约定（SPEC-03-EXT，勘误前禁止新增其他码）

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含幂等式「无事可做」的成功） |
| 1 | 运行期错误（任何经 `fail()` 输出的 SW-Exxx；亦含检查类命令发现问题） |
| 2 | 用法错误（参数/旗标解析失败，未进入业务逻辑） |

正文见 `docs/wave-02/P-gap-adjudication.md` §3.6。

## 错误码索引

| 错误码 | 发生了什么 | 段位 |
| --- | --- | --- |
| [`SW-E010`](./SW-E010.md) | 目标目录非空，初始化已中止 | SW-E01x 项目 / 文件系统 |
| [`SW-E011`](./SW-E011.md) | 当前目录不是 script-writer 项目 | SW-E01x 项目 / 文件系统 |
| [`SW-E012`](./SW-E012.md) | 项目正被另一个进程写入（项目锁被占用） | SW-E01x 项目 / 文件系统 |
| [`SW-E013`](./SW-E013.md) | 目标路径已存在且不是目录 | SW-E01x 项目 / 文件系统 |
| [`SW-E014`](./SW-E014.md) | 项目自检未通过（{count} 个红项） | SW-E01x 项目 / 文件系统 |
| [`SW-E020`](./SW-E020.md) | project.yaml 的 schema 版本不兼容 | SW-E02x 状态 / 版本 |
| [`SW-E021`](./SW-E021.md) | project.yaml 无法解析 | SW-E02x 状态 / 版本 |
| [`SW-E022`](./SW-E022.md) | project.yaml 字段不完整或类型错误 | SW-E02x 状态 / 版本 |
| [`SW-E030`](./SW-E030.md) | 场景 {sceneId} 不存在 | SW-E03x 输入校验 |
| [`SW-E031`](./SW-E031.md) | 模板不存在：{templateId} | SW-E03x 输入校验 |
| [`SW-E032`](./SW-E032.md) | 场编号不合法：{sceneId} | SW-E03x 输入校验 |
| [`SW-E033`](./SW-E033.md) | 不支持的导出格式：{format} | SW-E03x 输入校验 |
| [`SW-E034`](./SW-E034.md) | 没有可导出的内容 | SW-E03x 输入校验 |
| [`SW-E040`](./SW-E040.md) | 模型调用失败（{model}，已尝试 {attempts} 次） | SW-E04x AI 供应商 |
| [`SW-E041`](./SW-E041.md) | 未配置模型凭据，AI 功能未启用 | SW-E04x AI 供应商 |

注：SW-E04x（AI 供应商）段暂无登记——AI 默认关闭、无触达路径，
按 W1-P1-T06「禁止预填未用码」纪律待 AI 适配器落地时再登记。

## 空态位点索引（与错误文案同库管理、同 lint 覆盖）

| 位点 | 这里是什么 | 下一步命令 |
| --- | --- | --- |
| `scenes-empty` | scenes/ 目前是空的——这里按「一场一文件」存放每一场的正文（Markdown）。 | `sw draft 010 --title "开场"` |
| `outline-empty` | outline.md 还没有内容——这里是全片大纲，逐场列出场编号与一句话梗概。 | `sw outline` |
| `revise-empty` | scenes/ 还没有任何场——修订步针对既有场文件，无可修订对象。 | `sw draft 010 --title "开场"` |

空态由 `hint(slot, ctx)` 渲染（三要素：这里是什么 / 示例 / 下一步命令）；
位点接线属 W1-P1-T05/T07，接线前不得在用户可见输出中渲染。
