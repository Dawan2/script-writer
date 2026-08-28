# Story Bible（设定集）schema 说明（TASK-P3-06 定稿 v1）

设定集是 M2 结构层（P3 方案 §2.3）：人物卡、地点、伏笔登记；写入方 = 用户直接编辑 +
Agent 草稿提议（`upsert_bible_draft`，W2-PLAN-T01）。本目录一切文件**不直接进剧本正文**
——正文唯一权威是 `scenes/` + `outline.md`（M1）。

## 目录布局

```text
story-bible/
  characters/<id>.yaml    人物卡（schema 见下）
  locations/<id>.yaml     地点（字段同人物卡的子集：id/name/facts/notes）
  foreshadowing/<id>.yaml 伏笔登记（id/setup_scene/payoff_scene/status/notes）
  preferences/            M4 偏好层（作者风格偏好，自由文本）
```

## 人物卡最小 schema（characters/<id>.yaml）

```yaml
id: li-mei                # 必填，与文件名一致（小写连字符）
name: 李梅                # 必填，显示名（工具 get_bible_entry 按 name 检索）
role: 女主角              # 可选
facts:                    # 必填（可空数组）：不可违背的既定事实，一致性检查的依据
  - "左撇子"
  - "S03 起知晓父亲身份"
voice: "话少，句子短，习惯反问"   # 可选：语言风格
arc: "从回避冲突到主动对峙"      # 可选：人物弧线
first_appearance: S02     # 可选：首次出场场号
```

纪律：

1. `facts` 是一致性守卫（W2-PLAN-T03）与技能规则「不得虚构设定外事实」的**唯一依据**；
   事实变更走草稿提议（P-3），不直接改卡。
2. `id` 与文件名一致；`name` 与正文称呼一致（含别名时加 `aliases: [...]`）。
