# E4 · 运行时走查：init → status → markSceneDone → status 五步链互通

| 项 | 值 |
| --- | --- |
| 任务 ID | W3-PLAN-T05（集成终验；同时核销 W3-PLAN-T03 往返验收①②） |
| 证据类型 | E4 运行时行为 |
| 锚定 commit | `02f0a6a`（分支 `cursor/w3-integrate-w2-f334`） |
| 日期 | 2026-08-27（UTC） |
| 环境 | Linux（Cloud Agent VM）、Node v22.14.0、构建产物 dist/（`npm run build`） |
| 采集人 | W3 集成槽（Cloud Agent） |
| 脱敏声明 | 走查目录为 mktemp 临时路径（/tmp/…），不含用户主目录、凭据、邮箱、主机名 |

## 复现命令

```bash
npm run build
WALK=$(mktemp -d)
node dist/cli/main.js init --yes --scenes 5 "$WALK/demo"           # 步骤 1
cat "$WALK/demo/project.yaml"                                       # 步骤 2：确认 expectedSceneCount 写入
(cd "$WALK/demo" && node <repo>/dist/cli/main.js status)            # 步骤 3：分母 = expectedSceneCount
mkdir -p "$WALK/demo/scenes" && printf '# 场 010\n' > "$WALK/demo/scenes/010.md"
node -e "import('<repo>/dist/app/workflow/engine.js').then(m => m.markSceneDone('$WALK/demo','010'))"  # 步骤 4
cat "$WALK/demo/project.yaml"                                       # 步骤 5a：重写后字段不丢
(cd "$WALK/demo" && node <repo>/dist/cli/main.js status)            # 步骤 5b：进度推进
```

## 原始输出（含退出码）

### 步骤 1 — `sw init --yes --scenes 5`（退出码 0）

```text
✔ 项目已创建：/tmp/sw-walk-boos/demo
  标题：demo ｜ 类型：short-video ｜ 预计场数：5 ｜ AI 辅助：关
  模板：short-video
  产出：project.yaml、outline.md、.gitignore、characters/、scenes/、exports/
  下一步（可直接复制执行）：
cd /tmp/sw-walk-boos/demo && sw status
```

### 步骤 2 — 初始 project.yaml（`expectedSceneCount: 5` 已写入）

```yaml
schema: 1
title: demo
format: short-video
created: 2026-08-27
expectedSceneCount: 5
settings:
  ai:
    enabled: false
    provider: null
  export:
    default: markdown
progress:
  step: outline
  scenes_done: []
```

### 步骤 3 — `sw status` 初始（退出码 0，分母来自 expectedSceneCount）

```text
项目：demo（short-video）
当前步骤：outline（第 2/5 步：init → outline → draft → revise → export）
场景完成度：0/5 场已完成
下一步（可直接复制执行）：
sw outline
```

### 步骤 4/5a — `markSceneDone('010')` 引擎重写后的 project.yaml（**字段不丢**）

```yaml
schema: 1
title: demo
format: short-video
created: 2026-08-27
expectedSceneCount: 5
settings:
  ai:
    enabled: false
    provider: null
  export:
    default: markdown
progress:
  step: draft
  scenes_done:
    - "010"
```

### 步骤 5b — `sw status` 推进后（退出码 0）

```text
项目：demo（short-video）
当前步骤：draft（第 3/5 步：init → outline → draft → revise → export）
场景完成度：1/5 场已完成
下一步（可直接复制执行）：
sw draft 010 --title "开场"
```

## 结论

- 五步链互通：init 写入 → status 消费（0/5）→ 引擎重写 → **`expectedSceneCount: 5` 逐字保留**（集成图
  §3-⑥ 数据丢失风险核销）→ status 进度推进（1/5，步骤 outline→draft）。
- 字段名逐字 `expectedSceneCount`（GAP-03 裁决原文），schema 仍为 1，零迁移。
- 同一往返在自动化层由 `tests/cli/status.spec.ts` 的端到端用例常驻回归。
