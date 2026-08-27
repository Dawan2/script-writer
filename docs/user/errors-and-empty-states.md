# 空态与错态导读

> 本页是**导读**：教你读懂报错与空态提示、三跳内找到修复动作。逐码正文的唯一权威来源是
> [`docs/errors/`](../errors/README.md)（SPEC-03 注册表生成物，**手改会被 CI `lint:errors` 拦截**；
> 改文案须改 `src/app/errors/registry.ts` 后 `npm run gen:errors` 重新生成）。
> 框架设计正文见 [P1 方案 §7 SPEC-03](../wave-01/P1-usability-architecture.md) 与
> [`wave-02/work-error-framework.md`](../wave-02/work-error-framework.md)（集成分支已含），此处不复制。

## 1. 报错长什么样（三段式）

所有用户可见错误统一为「发生了什么 / 原因 / 怎么办」三段 + 详情锚点，例如在非项目目录运行 `sw status`：

```text
✖ SW-E011 当前目录不是 script-writer 项目
  原因：未找到 project.yaml（查找位置：/home/writer/somewhere）。
  怎么办：运行 `sw init` 新建项目，或 cd 到既有项目目录。
  详情：https://github.com/Dawan2/script-writer/blob/main/docs/errors/SW-E011.md
```

**遇错三步法**：

1. 先照「怎么办」行操作——修复命令能复制就直接复制执行；
2. 不够用就点末行「详情」链接（即 [`docs/errors/SW-Exxx.md`](../errors/README.md) 逐码页，含示例输出与上下文占位说明）；
3. 反复报错、怀疑项目坏了 → 跑 `sw doctor`（体检 + 逐项修复命令，**待并入**，状态见[命令索引](./commands.md)）；迷路了 → 跑 `sw status` 找回下一步。

## 2. 退出码怎么读（写脚本 / 接 CI 时用）

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含幂等式「无事可做」的成功） |
| 1 | 运行期错误（任何 SW-Exxx；亦含检查类命令**发现问题**，如 doctor 红项、check 违规） |
| 2 | 用法错误（参数 / 旗标解析失败，未进入业务逻辑，无落盘副作用） |

权威表与勘误前「禁止新增其他码」纪律见 [`docs/errors/README.md`](../errors/README.md)，
裁决正文 [`wave-02/P-gap-adjudication.md`](../wave-02/P-gap-adjudication.md) §3.6（SPEC-03-EXT）。

## 3. 错误码段位速览（查码先看段位）

| 段位 | 主题 | 现状 |
| --- | --- | --- |
| `SW-E01x` | 项目 / 文件系统（目录非空、不是项目…） | 已登记，见 [errors 索引](../errors/README.md) |
| `SW-E02x` | 状态 / 版本（project.yaml 不可解析、schema 不兼容…） | 已登记，同上 |
| `SW-E03x` | 输入校验（场编号不存在、模板不存在…） | 部分登记；E032–E034 已预留编号（draft/export 规格） |
| `SW-E04x` | AI 供应商 | 暂无登记（AI 默认关闭、无触达路径，按「禁止预填未用码」纪律待适配器落地再登记） |
| `SW-E05x` | 快照 / 历史 | 提案级（[`wave-03/spec-check-snapshot.md`](../wave-03/spec-check-snapshot.md) §5.10，实现槽触达时登记） |

逐码清单不在本页维护——以 [`docs/errors/README.md`](../errors/README.md) 的自动生成索引为准。

## 4. 空态提示怎么读（空 ≠ 错）

空的目录 / 文件不是错误：工具输出**空态三要素**——「这里是什么 / 示例长什么样 / 下一步敲什么命令」，
末行命令可直接复制执行。已登记的空态位点（与错误文案同注册表管理、同 lint 覆盖）：

| 位点 | 你会在哪看到 | 下一步命令 |
| --- | --- | --- |
| `outline-empty` | `outline.md` 还没有内容 | `sw outline` |
| `scenes-empty` | `scenes/` 目前是空的 | `sw draft 010 --title "开场"` |

位点清单与文案以 [`docs/errors/README.md`](../errors/README.md)「空态位点索引」为准。
**接线状态如实**：空态渲染（`hint()`）的用户可见接线属 W1-P1-T05/T07 范围，接线前你只会在
模板文件内注释与 `sw status` 建议中看到等价引导，不会看到独立空态输出。

## 5. 常见处境速查

| 处境 | 一句话 | 去哪 |
| --- | --- | --- |
| 「不是 script-writer 项目」 | 你不在项目目录，或还没建项目 | [`SW-E011`](../errors/SW-E011.md)；`sw init`（待并入） |
| 「project.yaml 无法解析 / 字段错 / 版本不兼容」 | 状态文件坏了或被旧版工具写过 | [`SW-E02x` 各码页](../errors/README.md)；`sw doctor` 逐项体检（待并入） |
| 「目标目录非空，初始化已中止」 | init 拒绝覆盖你的文件 | [`SW-E010`](../errors/SW-E010.md)（附 `--force` 及其后果） |
| 「场景 xxx 不存在」 | 场编号打错或该场未创建 | [`SW-E030`](../errors/SW-E030.md)；`sw status` 看已有进度 |
| 不知道自己卡在哪一步 | 不是错，是迷路 | `sw status`——末行即下一步命令 |
