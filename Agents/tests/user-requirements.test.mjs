import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getUserRequirements } from "../.claude/tools/get-user-requirements.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacesRoot = path.join(agentsRoot, "workspaces");

async function createWorkspace(t) {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(workspacesRoot, "user-requirements-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function writeProjectInput(workspace, project) {
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), JSON.stringify({
    schema_version: "1.1.0",
    project,
    status: "project_init:completed",
    audit: { created_by: "test", workspace: "do-not-return" }
  }, null, 2), "utf8");
}

test("读取用户需求只返回语义化且可用的项目约束", async (t) => {
  const workspace = await createWorkspace(t);
  await writeProjectInput(workspace, {
    project_name: "禁忌名单",
    task_type: "rewrite",
    workspace: "workspaces/private-project",
    target_region: "北美",
    target_language: "en-US",
    requires_translation: true,
    distribution_brief: {
      target_countries: ["美国", "美国", ""],
      target_locale: "en-US",
      market_deliverables: [{ market: "美国", locale: "en-US" }],
      episode_duration: "90 秒",
      target_episode_count: 42,
      maturity_target: "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
      theme: ["现代言情", "悬疑"],
      setting: ["大女主"],
      background: ["现代", "都市"],
      audience: ["女频"]
    },
    source_script: {
      display_name: "原剧本",
      output_path: "output/原始剧本.md",
      reference_path: "references/原剧本.docx",
      converter: "mammoth"
    },
    attachments: [
      {
        original_name: "人物设定.pdf",
        reference_path: "references/人物设定.pdf",
        text_path: "references/人物设定-文本.md",
        text_status: "available",
        converter: "pdf-parse"
      },
      {
        original_name: "图片参考.png",
        reference_path: "references/图片参考.png",
        text_path: "",
        text_status: "unsupported"
      }
    ],
    extra_requirements: "强化女主的主动选择。"
  });

  const result = await getUserRequirements(workspace);
  const requirements = result["用户需求"];
  assert.equal(requirements["任务场景"], "剧本改写");
  assert.equal(requirements["项目名称"], "禁忌名单");
  assert.equal(requirements["目标发行地区"], "北美");
  assert.deepEqual(requirements["目标市场"], ["美国"]);
  assert.equal(requirements["主要交付语言"], "英语（美国，en-US）");
  assert.equal(requirements["交付要求"], "生成中文剧本及目标语台词译稿");
  assert.equal(requirements["单集时长"], "90 秒");
  assert.equal(requirements["目标集数"], 42);
  assert.deepEqual(requirements["受众"], ["女频"]);
  assert.deepEqual(requirements["主题"], ["现代言情", "悬疑"]);
  assert.deepEqual(requirements["背景"], ["现代", "都市"]);
  assert.deepEqual(requirements["设定"], ["大女主"]);
  assert.equal(requirements["原始材料"]["内容文件"], "output/原始剧本.md");
  assert.deepEqual(requirements["可读附件"], [{ "名称": "人物设定.pdf", "内容文件": "references/人物设定-文本.md" }]);

  const serialized = JSON.stringify(result);
  ["schema_version", "audit", "workspace", "reference_path", "market_deliverables", "converter"].forEach((field) => {
    assert.equal(serialized.includes(field), false, `不应返回内部字段 ${field}`);
  });
});

test("读取用户需求省略未填写和不可读的字段", async (t) => {
  const workspace = await createWorkspace(t);
  await writeProjectInput(workspace, {
    project_name: "空白任务",
    task_type: "humanize",
    target_region: "国内",
    requires_translation: false,
    distribution_brief: {
      target_countries: [],
      target_locale: "",
      episode_duration: "",
      target_episode_count: null,
      maturity_target: ""
    },
    source_script: { display_name: "", output_path: "../不应返回.md" },
    attachments: [{ original_name: "无法读取.pdf", text_status: "unavailable", text_path: "references/无法读取.md" }],
    extra_requirements: "   "
  });

  const requirements = (await getUserRequirements(workspace))["用户需求"];
  assert.deepEqual(requirements, {
    "任务场景": "剧本润色",
    "项目名称": "空白任务",
    "目标发行地区": "国内",
    "交付要求": "仅生成中文剧本，不生成台词译稿"
  });
});

test("读取用户需求拒绝无效项目输入和工作区", async (t) => {
  const workspace = await createWorkspace(t);
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), "{}", "utf8");
  await assert.rejects(getUserRequirements(workspace), /缺少项目资料/u);

  const outsideWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "user-requirements-outside-"));
  t.after(() => fs.rm(outsideWorkspace, { recursive: true, force: true }));
  await assert.rejects(getUserRequirements(outsideWorkspace), /必须位于 workspaces/u);
});

test("内容 Skill 只通过受控工具或执行规范获取项目输入", async () => {
  const skillFiles = [
    "novel_analysis/SKILL.md",
    "world_view/SKILL.md",
    "outline_rewrite/SKILL.md",
    "character_rewrite/SKILL.md",
    "trial_generate/SKILL.md",
    "full_generate/SKILL.md",
    "dialogue_translate/SKILL.md",
    "foreign_review/SKILL.md",
    "humanizer-zh/SKILL.md"
  ];
  const contents = await Promise.all(skillFiles.map((relativePath) => fs.readFile(
    path.join(agentsRoot, ".claude", "skills", relativePath),
    "utf8"
  )));
  contents.forEach((content, index) => {
    if ([
      "world_view/SKILL.md",
      "outline_rewrite/SKILL.md",
      "character_rewrite/SKILL.md",
      "trial_generate/SKILL.md",
      "full_generate/SKILL.md"
    ].includes(skillFiles[index])) {
      assert.match(content, /执行规范\.md/u, `${skillFiles[index]} 缺少统一执行规范`);
    } else {
      assert.match(content, /get-user-requirements\.mjs/u, `${skillFiles[index]} 缺少读取用户需求工具`);
    }
    assert.doesNotMatch(content, /1\.1-user-input\.json/u, `${skillFiles[index]} 不应直接读取项目输入`);
  });

  const scenarioReferences = [
    "outline_rewrite/references/剧本改写场景执行步骤.md",
    "outline_rewrite/references/小说改编场景执行步骤.md",
    "outline_rewrite/references/爆款复刻场景执行步骤.md"
  ];
  const references = await Promise.all(scenarioReferences.map((relativePath) => fs.readFile(
    path.join(agentsRoot, ".claude", "skills", relativePath),
    "utf8"
  )));
  references.forEach((content, index) => {
    assert.match(content, /读取用户需求/u, `${scenarioReferences[index]} 缺少读取用户需求步骤`);
    assert.doesNotMatch(content, /1\.1-user-input\.json/u, `${scenarioReferences[index]} 不应绕过工具`);
  });
});
