import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDistributionBrief } from "../.claude/tools/distribution-brief.mjs";
import { getAdaptationContext } from "../.claude/tools/get-adaptation-context.mjs";
import { initializeFull } from "../.claude/skills/full_generate/scripts/init-full.mjs";
import { getStageInfo } from "../.claude/skills/full_generate/scripts/get-stage-info.mjs";
import { checkOutline } from "../.claude/skills/outline_rewrite/scripts/check-outline.mjs";
import { initializeOutline } from "../.claude/skills/outline_rewrite/scripts/init-outline.mjs";
import { getOutlineExecutionStrategy } from "../.claude/skills/outline_rewrite/scripts/get-execution-strategy.mjs";
import { getEpisodeInfo } from "../.claude/skills/trial_generate/scripts/get-episode-info.mjs";
import { checkWorldView } from "../.claude/skills/world_view/scripts/check-world-view.mjs";
import { initializeWorldView } from "../.claude/skills/world_view/scripts/init-world-view.mjs";
import { getWorldViewExecutionStrategy } from "../.claude/skills/world_view/scripts/get-execution-strategy.mjs";
import { resolveScriptProfile } from "../.claude/tools/resolve-script-profile.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function replicationProjectInput() {
  const brief = buildDistributionBrief({
    targetCountry: "美国",
    targetLocale: "en-US",
    targetEpisodeCount: "35",
    defaultLocale: "en-US"
  });
  return {
    project: {
      project_name: "新剧本项目",
      task_type: "replicate",
      target_region: "北美",
      distribution_brief: brief,
      source_script: {
        reference_path: "references/爆款分析报告.md",
        display_name: "测试爆款分析报告",
        output_path: "output/爆款分析报告.md"
      }
    },
    audit: {
      created_at: "2026-08-05T00:00:00.000Z",
      created_by: "tester",
      updated_at: "2026-08-05T00:00:00.000Z",
      updated_by: "tester"
    }
  };
}

function episode(number) {
  return {
    "集数": number,
    "剧集名称": `第${number}集的反转`,
    "关键角色": ["莉娜"],
    "写作思路": {
      "开场冲突": "莉娜面临新的公开阻碍。",
      "主要转折": ["她主动选择更难但能改变局面的行动。"],
      "结尾承接": "对手拿出更高一级的阻止手段。"
    },
    "剧集梗概": "莉娜主动应对公开阻碍，以新的行动改变局面，并留下更强对手即将出手的悬念。"
  };
}

function replicationOutline() {
  return {
    "剧本名称": "失约之后",
    "英文剧本名称": "After the Broken Promise",
    "关键角色名称映射": [{ "英文名称": "Lena", "中文名称": "莉娜" }],
    "故事梗概": "莉娜在失去重要资格后接受公开挑战，以连续反转夺回选择权，并让压制者承担后果。",
    "开篇": {
      "开篇描述": "莉娜被当众夺走资格后，主动接受一场带期限的公开挑战。",
      "关键角色": ["莉娜"],
      "剧集": [episode(1)]
    },
    "剧情单元": [{
      "单元名称": "逐级反制",
      "单元描述": "莉娜面对不断升级的规则与阻拦，用主动选择逐步夺回局面。",
      "关键角色": ["莉娜"],
      "剧集": Array.from({ length: 34 }, (_, index) => episode(index + 2))
    }]
  };
}

test("爆款复刻直接使用分析报告，不生成基线或大纲隐藏字段", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-replication-report-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  await writeJson(path.join(workspace, "1.1-user-input.json"), replicationProjectInput());
  await writeJson(path.join(workspace, "1.2-project-progress.json"), {
    stages: {
      project_init: { status: "completed" },
      world_view: { status: "pending" },
      outline_rewrite: { status: "pending" }
    },
    audit: {
      created_at: "2026-08-05T00:00:00.000Z",
      created_by: "tester",
      updated_at: "2026-08-05T00:00:00.000Z",
      updated_by: "tester"
    }
  });
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  await fs.writeFile(path.join(workspace, "output/爆款分析报告.md"), "# 测试爆款分析报告\n\n主角必须在公开挑战中夺回选择权。\n", "utf8");

  const worldInit = await initializeWorldView(workspace, "tester");
  assert.equal(Object.hasOwn(worldInit, "replication_baseline_file"), false);
  await assert.rejects(fs.access(path.join(workspace, "runtime/爆款复刻基线.json")), { code: "ENOENT" });
  await resolveScriptProfile({
    workspace,
    stage: "world_view",
    updatedBy: "tester",
    theme: "商战",
    setting: "大女主,业界精英",
    background: "现代,都市,职场",
    audience: "女频"
  });
  await initializeWorldView(workspace, "tester");
  await getWorldViewExecutionStrategy(workspace);

  await writeJson(path.join(workspace, "2.1-world-view.json"), {
    "世界观描述": "故事发生在一家由公开挑战决定晋升的公司。",
    "关键概念映射": []
  });
  assert.equal((await checkWorldView(workspace, "tester")).ok, true);

  const context = await getAdaptationContext(workspace);
  assert.equal(context.source_file, "output/爆款分析报告.md");
  assert.equal(Object.hasOwn(context, "replication_baseline"), false);

  const alteredInput = replicationProjectInput();
  alteredInput.project.source_script.output_path = "output/不应读取的文件.md";
  await writeJson(path.join(workspace, "1.1-user-input.json"), alteredInput);
  const fixedReportContext = await getAdaptationContext(workspace);
  assert.equal(fixedReportContext.source_file, "output/爆款分析报告.md");
  await writeJson(path.join(workspace, "1.1-user-input.json"), replicationProjectInput());

  const outlineInit = await initializeOutline(workspace, "tester");
  await getOutlineExecutionStrategy(workspace);
  assert.equal(Object.hasOwn(outlineInit, "replication_stage_ids"), false);
  const initialized = JSON.parse(await fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8"));
  assert.equal(Object.hasOwn(initialized["开篇"], "复刻剧情阶段"), false);

  await writeJson(path.join(workspace, "3.1-outline.json"), replicationOutline());
  assert.equal((await checkOutline(workspace, "tester")).ok, true);

  await writeJson(path.join(workspace, "4.1-character.json"), [{
    "人物名称": "莉娜",
    "核心诉求": "夺回被剥夺的选择权。",
    "人物难题": "必须在公开挑战中面对掌权者。",
    "关系与弧光": "她从被动承受者变为主动反制者。",
    "阶段变化": []
  }]);
  const episodeInfo = await getEpisodeInfo(workspace, { episode: 1 });
  assert.equal(Object.hasOwn(episodeInfo, "replication_stages"), false);
  const revisionProgress = await fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  revisionProgress.stages.trial_generate = { status: "pending" };
  revisionProgress.stages.full_generate = { status: "stale", completed_once: true };
  await writeJson(path.join(workspace, "1.2-project-progress.json"), revisionProgress);
  const fullRevision = await initializeFull(workspace, "tester");
  assert.equal(fullRevision.generation_mode, "full_revision");
  const stageInfo = await getStageInfo(workspace, "逐级反制");
  assert.equal(stageInfo.generation_mode, "full_revision");
  assert.equal(Object.hasOwn(stageInfo, "replication_stages"), false);

  const legacyOutline = replicationOutline();
  legacyOutline["开篇"]["复刻剧情阶段"] = [];
  await writeJson(path.join(workspace, "3.1-outline.json"), legacyOutline);
  const rejected = await checkOutline(workspace, "tester");
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues.join("\n"), /开篇字段必须与 outline\.json5 一致/u);
});
