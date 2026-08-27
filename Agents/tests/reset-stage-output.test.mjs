import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetStageOutput } from "../.claude/tools/reset-stage-output.mjs";

const STAGE_OUTPUTS = {
  novel_analysis: ["2.1-novel-analysis.json", "runtime/novel-source-index.json"],
  world_view: ["2.1-world-view.json"],
  outline_rewrite: ["3.1-outline.json", "output/剧本大纲.md", "output/新剧-故事梗概.md"],
  character_rewrite: ["4.1-character.json", "output/角色小传.md"],
  trial_generate: ["output/剧本试稿.md"],
  full_generate: ["output/剧本全稿.md", "output/新剧-剧本全稿.md", "tmp/全稿分阶段/01-开篇.md"],
  dialogue_translate: [
    "output/台词译稿.md",
    "output/新剧-台词译稿.md",
    "7.1-lines-001.json",
    "runtime/dialogue-translate/manifest.json"
  ],
  foreign_review: [
    "review-scorecard.json",
    "output/审稿报告.md",
    "runtime/review-scoring.json",
    "runtime/review-source-index.json",
    "runtime/review-coverage.json",
    "runtime/review-ledger.json"
  ],
  humanizer_zh: ["output/去AI味剧本.md"]
};

async function writeFile(workspace, relativePath, content = "旧内容") {
  const target = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

test("全新重新生成只清理当前阶段的产物", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-reset-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const [stage, stageOutputs] of Object.entries(STAGE_OUTPUTS)) {
    const workspace = path.join(root, stage);
    await Promise.all([
      writeFile(workspace, "1.1-user-input.json", "项目输入"),
      writeFile(workspace, "1.2-project-progress.json", "项目进度"),
      writeFile(workspace, "output/原始剧本.md", "原始剧本"),
      writeFile(workspace, "references/source.md", "附件"),
      writeFile(workspace, "memory/outline_rewrite_memory.json", "记忆"),
      ...stageOutputs.map((relativePath) => writeFile(workspace, relativePath))
    ]);

    await resetStageOutput(workspace, stage);

    for (const relativePath of stageOutputs) {
      await assert.rejects(fs.lstat(path.join(workspace, relativePath)), { code: "ENOENT" });
    }
    for (const relativePath of [
      "1.1-user-input.json",
      "1.2-project-progress.json",
      "output/原始剧本.md",
      "references/source.md",
      "memory/outline_rewrite_memory.json"
    ]) {
      await fs.access(path.join(workspace, relativePath));
    }
  }
});

test("清理工具拒绝未知阶段", async () => {
  await assert.rejects(resetStageOutput(process.cwd(), "unknown_stage"), /不支持清理的阶段/u);
});
