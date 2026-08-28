# W3-DRAFT-T03 落地说明：主链进程级 e2e + TTFS 基准

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：W3-DRAFT-T03；规格 §10 总验收表第 1–6 项收口（主链走通、TTFS ≤ 5、退出码冒烟、注册纪律、CI 门、GAP-04 回归）

## 文件改动

| 文件 | 改动 |
|---|---|
| `scripts/e2e-mainchain.mjs`（新） | 进程级主链 e2e：临时目录跑构建产物 `dist/cli/main.js`，链 `init --yes → draft 010 --title 开场 → draft 010 --done → export`；每步断言退出码 0 + stdout 末行逐字匹配可复制下一步命令；终态断言 `exports/` 恰好 1 个 `.md` 产物 |
| `scripts/smoke-exit-codes.mjs`（改，只加不改） | 头部新增 chainDir（init 后）与 emptyProjDir（init 后删 outline.md 构造双空）；CASES 尾部 +9：draft 0/2/1（SW-E030）、revise 0/2/1、export 0/1（SW-E033）/1（SW-E034）；清理处同步 rmSync 两个新目录 |
| `package.json`（改） | +`smoke:e2e` 脚本 |
| `.github/workflows/ci.yml`（改） | smoke:exit-codes 步骤后新增一步 `npm run smoke:e2e`（CI 七门 → 八门） |

## 验收核销

| 项 | 结果 |
|---|---|
| 主链 e2e 4 步全绿（末行逐字断言） | ✅ `sw status` / `sw draft 010 --done` / `sw draft 020` / `sw status` |
| TTFS ≤ 5 条命令 | ✅ 4 条（outline 由 init 模板骨架就位，主链免显式调用；revise 可跳过——SPEC-04 可跳过条款） |
| 终态产物 | ✅ `exports/*.md` 恰好 1 个 |
| 退出码冒烟 | ✅ 22/22（13 → 22，draft/revise/export 三命令各覆盖 0/1/2 三档） |
| CI 门 | ✅ 八门：lint / lint:errors / typecheck / test（426：425 过 + 1 todo）/ build / smoke / smoke:exit-codes / smoke:e2e 全绿，0 跳过 |
| 真实 CLI 手测五步全链 | ✅ init → outline → draft → revise（+--done）→ export → status，末行建议逐环正确，exports/ 产物就位 |

## 关键裁定

1. **emptyProjDir 双空构造**：`sw init --yes` 生成的 outline.md 含模板骨架（非空），不触发 SW-E034；冒烟脚本在 init 后删 outline.md 以构造「无大纲无场」双空态（SPEC-06 §5.4-④）。此为本波唯一的实测偏差修正，属脚本层，不动 app 逻辑。
2. **distEntry 上移**：CASES 用例引用 chainDir/emptyProjDir，二者构建依赖 distEntry，故将其定义上移至 CASES 之前（原定义删除，单一定义点）。
3. **TTFS 口径**：以用户从零到拿到第一份导出物的命令数计 = 4（init、draft×2、export）；≤ 5 达标。

## §10 总验收表收口对照（引用前序落地说明，不重做）

| §10 项 | 核销出处 |
|---|---|
| 1. 单命令验收（init/outline/status/help） | `docs/wave-01`、`docs/wave-04/work-doctor.md` 前序回执 |
| 2. 主链 e2e + TTFS | 本文档 |
| 3. 退出码 0/1/2 冒烟 | `scripts/smoke-exit-codes.mjs` 22/22 |
| 4. 注册表 planned→available 纪律 | 各命令首个触达提交（DISPATCH 回执逐波） |
| 5. CI 门全绿 0 跳过 | 本波起八门 |
| 6. GAP-04 文件锁回归 | `docs/wave-04/work-file-lock.md`（AT-L01…L15） |

## 阻塞

无新增。BLK-W1-02（模型凭据）仍开放，与本槽无关。

## 合规声明

未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准；未合并任何内容进 `main`。
