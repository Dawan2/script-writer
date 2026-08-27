# C1-W1-13 前端测试基座 · 验收证据

对应文档：`docs/iteration/cycle-01/W2-C1-W1-13-前端测试基座.md`。全部输出取自 `cursor/w1-13-web-test-harness-058e`。

| 文件 | 内容 |
| --- | --- |
| `test-web-输出.txt` | `npm run test:web` 的输出，另附逐项清单 |
| `npm-test-串接到前端.txt` | `npm test` 四个套件的分段与末尾汇总，可见链条完整执行到 `test:web` |
| `静态检查-通过与拦截.txt` | 网络出口静态检查在当前代码上通过、在反例夹具上拦截的两段输出 |
| `端到端骨架-输出.txt` | `npm run test:web:e2e` 的输出 |

复跑前提：`npm install`（根）、`cd Agents && npm install`、`apps/api` 装 `requirements.txt` 与测试依赖（`httpx`）；端到端另需 `cd apps/web && npm run test:e2e:install`。
