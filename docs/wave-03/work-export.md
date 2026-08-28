# W3 实现槽落地说明：`sw export` 导出命令（W3-DRAFT-T02 / SPEC-06，markdown v1）

> 分支：`cursor/w4-help-registry-impl`（含 W4 help 注册表、outline、draft 落地）
> 开工依据：`docs/wave-03/spec-draft-export-revise.md` §5（SPEC-06）、§3 公共契约、§10 测试验收总表
> 日期：2026-08-28

## 1. 交付清单

| 文件 | 说明 |
| --- | --- |
| `src/app/workflow/exportRender.ts`（新） | `renderMarkdownExport` 纯函数零 IO：产物布局（标题/头部注释/大纲节/场景节，空节省略）；无导出时间戳（确定性裁定 1） |
| `src/app/workflow/export.ts`（新） | `runExport`：格式归一校验（md ≡ markdown，其余 → SW-E033，含 settings.export.default 缺省路径）；磁盘现状聚合（非 scenes_done）；双空 → SW-E034 零产物；`--out` 相对 cwd 解析；成功后 `ensureStepAtLeast('export')` 原子回写 |
| `src/app/workflow/exportReport.ts`（新） | 产物路径 + 完成度（`导出 N 场（已标记完成 x/N）`）+ 未完成提示行（不阻塞导出）；末行 `sw status`（链尾） |
| `src/infra/store/exportFile.ts`（新） | `writeExportFile`：父目录递归创建 + writeFileAtomic；派生产物允许覆盖（§5.2-5） |
| `src/infra/store/outlineFile.ts` / `sceneFile.ts`（改） | 新增读侧 `readOutlineText` / `readSceneFiles`（聚合数据源） |
| `src/cli/commands/export.ts`（新） | CLI 适配；注册表 export planned→available（别名 x 生效，SPEC-07 同提交纪律） |
| `src/app/errors/registry.ts`（改） | 登记 **SW-E033**（{format}）与 **SW-E034**（无 ctx），与首个触达用例同提交；`gen:errors` 生成两码文档，lint 零漂移 |
| 测试（新） | `tests/app/export.spec.ts`（11 例，§5.4 ①–⑨ 引擎级 + 纯函数出口）、`tests/cli/export.spec.ts`（5 例，§5.4-⑩ + 别名等价） |

## 2. SPEC-06 §5.4 验收 ①–⑩ 核销表

| # | 要点 | 结果 | 证据 |
| --- | --- | --- | --- |
| ① | 全链产物存在、含大纲/场景节、场序升序 | ✅ | export.spec「①」 |
| ② | 重复导出字节级相同、退出码 0 | ✅ | export.spec「②」+ 真实 CLI 连跑两次 |
| ③ | md ≡ markdown 字节相同；fountain → E033、退出码 1、零产物 | ✅ | export.spec「③」+ 手测（exit=1，三段式 + 锚点） |
| ④ | 空项目 → E034、退出码 1、exports/ 无新文件 | ✅ | export.spec「④」+ cli spec |
| ⑤ | settings.export.default 改坏 → 缺省 E033（指引改回）；显式 --format 可覆盖 | ✅ | export.spec「⑤」 |
| ⑥ | --out 含不存在父目录写入成功 | ✅ | export.spec「⑥」 |
| ⑦ | outline 缺失有场 → 大纲节省略、成功 | ✅ | export.spec「⑦」+ 全空白同法 |
| ⑧ | 未标完成场存在 → 成功 + 完成度提示行 | ✅ | export.spec「⑧」+ 手测提示行 |
| ⑨ | 导出后 step=export；已在 export 步重复导出不改 project.yaml 字节 | ✅ | export.spec「②」 |
| ⑩ | --help 含 ≥1 可复制示例 | ✅ | cli export.spec |

## 3. 真实 CLI 走查

`init --yes → outline → draft 010 --title 开场 → export`：产物 `exports/<标题>.md` 含头部注释行（无时间戳）、大纲节（模板注释原样保留）、场景节；重复导出字节相同；`--format fountain` → `✖ SW-E033` 三段式 + 文档锚点，退出码 1。

## 4. 测试对账与 CI

- 测试 321 → **350（349 过 + 1 todo）**，只增不减；0 跳过。
- CI 七门全绿：lint / lint:errors（11 码零漂移）/ typecheck / test / build / smoke / smoke:exit-codes（12/12）。

## 5. 交接与余项

1. MP-01 五步主链已有四步可用（init/outline/draft/export）；revise（W2-GAP-T01）落地后链闭合成环。
2. status 在 step=export 的既有建议 `sw export` 保持不变（重复导出合法、幂等刷新，§5.3）。
3. fountain（W1-P4-T06）/ pdf（W1-P4-T07）未预实现、未预占错误码（ADR-0001 §3.6 边界）。
4. v1 已知限制登记：原文拼接不做标题降级/注释剥离/台词格式化（§5.2-4），导出管线插件化接管后处理链。

## 6. 合规声明

未创建 PR；未合并进 `main`；未删测试、未跳过失败、未降低 CI 标准；错误码仅经 `fail()` 单一入口；业务代码零 `process.exit` 触碰。
