import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renameScriptTitle } from "../.claude/tools/rename-script-title.mjs";
import {
  dialogueTranslationRelativePath,
  fullScriptRelativePath,
  outlineDocumentRelativePath
} from "../.claude/tools/script-artifacts.mjs";

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse);
}

function fixtureOutline() {
  return {
    "剧本名称": "边界追查",
    "英文剧本名称": "Boundary Pursuit",
    "关键角色名称映射": [],
    "故事梗概": "测试梗概。",
    "开篇": { "开篇描述": "测试开篇。", "关键角色": [], "剧集": [] },
    "剧情单元": []
  };
}

function fixtureUserInput() {
  return {
    project: {
      task_type: "rewrite",
      project_name: "边界追查",
      requires_translation: true,
      source_script: { display_name: "原始剧本" }
    },
    audit: {}
  };
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agents-rename-script-title-"));
  const outline = fixtureOutline();
  const userInput = fixtureUserInput();
  const outlinePath = outlineDocumentRelativePath(outline);
  const fullPath = fullScriptRelativePath(outline);
  const dialoguePath = dialogueTranslationRelativePath(outline, userInput);
  const outlineText = "# 边界追查 - 故事梗概\n\n测试梗概。\n";
  const fullText = "# 边界追查 - 剧本全稿\n\n## 第1集\n\n正文。\n";
  const dialogueText = "# 边界追查 - 台词译稿\n\n## 第1集\n\n台词。\n";
  const reportText = "# 《边界追查》审稿报告\n\n### 2. 剧本信息\n\n- 剧集名称：边界追查\n";
  const scoringText = { "剧本哈希": hashText(dialogueText), "维度": [], "总分": 0, "总体评级": "" };
  const decisionHashes = {
    [dialoguePath]: hashText(dialogueText),
    "review-scorecard.json": "old-scorecard-hash",
    "runtime/review-scoring.json": "old-scoring-hash",
    "output/审稿报告.md": hashText(reportText)
  };

  await writeJson(path.join(workspace, "1.1-user-input.json"), userInput);
  await writeJson(path.join(workspace, "3.1-outline.json"), outline);
  await writeJson(path.join(workspace, "1.2-project-progress.json"), {
    stages: {
      outline_rewrite: { status: "completed", output_files: ["3.1-outline.json", outlinePath] },
      full_generate: { status: "completed", output_files: [fullPath] },
      dialogue_translate: { status: "completed", output_files: [dialoguePath] },
      foreign_review: { status: "approved", output_files: ["review-scorecard.json", "output/审稿报告.md"], review_decision: { artifact_hashes: decisionHashes } }
    },
    audit: {}
  });
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspace, outlinePath), outlineText, "utf8"),
    fs.writeFile(path.join(workspace, fullPath), fullText, "utf8"),
    fs.writeFile(path.join(workspace, dialoguePath), dialogueText, "utf8"),
    fs.writeFile(path.join(workspace, "output", "审稿报告.md"), reportText, "utf8")
  ]);
  await writeJson(path.join(workspace, "runtime", "dialogue-translate", "manifest.json"), {
    source_file: fullPath,
    source_hash: hashText(fullText),
    output_file: dialoguePath,
    output_heading: "# 边界追查 - 台词译稿"
  });
  await writeJson(path.join(workspace, "review-scorecard.json"), {
    "剧本信息": { "剧本名称": "边界追查" },
    "审稿信息": {
      "剧本文件": dialoguePath,
      "剧本哈希": hashText(dialogueText),
      "可用材料": [fullPath, dialoguePath]
    }
  });
  await writeJson(path.join(workspace, "runtime", "review-source-index.json"), { script_path: dialoguePath, script_hash: hashText(dialogueText), units: [] });
  await writeJson(path.join(workspace, "runtime", "review-coverage.json"), { script_hash: hashText(dialogueText), ranges: [] });
  await writeJson(path.join(workspace, "runtime", "review-ledger.json"), { script_hash: hashText(dialogueText), units: [] });
  await writeJson(path.join(workspace, "runtime", "review-scoring.json"), scoringText);
  return { workspace, outline, userInput, outlinePath, fullPath, dialoguePath };
}

test("剧本名称同步会更新已生成文件、翻译和审稿引用", async (t) => {
  const fixture = await createWorkspace();
  t.after(() => fs.rm(fixture.workspace, { recursive: true, force: true }));

  const result = await renameScriptTitle({
    workspace: fixture.workspace,
    title: "失控证据",
    englishTitle: "Evidence Unbound",
    updatedBy: "rename-test"
  });
  const nextOutline = { ...fixture.outline, "剧本名称": "失控证据", "英文剧本名称": "Evidence Unbound" };
  const nextUserInput = structuredClone(fixture.userInput);
  nextUserInput.project.project_name = "失控证据";
  const nextOutlinePath = outlineDocumentRelativePath(nextOutline);
  const nextFullPath = fullScriptRelativePath(nextOutline);
  const nextDialoguePath = dialogueTranslationRelativePath(nextOutline, nextUserInput);
  const nextFullText = "# 失控证据 - 剧本全稿\n\n## 第1集\n\n正文。\n";
  const nextDialogueText = "# 失控证据 - 台词译稿\n\n## 第1集\n\n台词。\n";

  assert.equal(result.ok, true);
  assert.deepEqual(result.output_files, {
    outline: nextOutlinePath,
    full_script: nextFullPath,
    dialogue_translation: nextDialoguePath
  });
  await assert.rejects(fs.access(path.join(fixture.workspace, fixture.outlinePath)));
  await assert.rejects(fs.access(path.join(fixture.workspace, fixture.fullPath)));
  await assert.rejects(fs.access(path.join(fixture.workspace, fixture.dialoguePath)));
  assert.match(await fs.readFile(path.join(fixture.workspace, nextOutlinePath), "utf8"), /^# 失控证据 - 故事梗概/mu);
  assert.equal(await fs.readFile(path.join(fixture.workspace, nextFullPath), "utf8"), nextFullText);
  assert.equal(await fs.readFile(path.join(fixture.workspace, nextDialoguePath), "utf8"), nextDialogueText);

  const [input, outline, manifest, scorecard, index, coverage, ledger, scoring, progress, report] = await Promise.all([
    readJson(path.join(fixture.workspace, "1.1-user-input.json")),
    readJson(path.join(fixture.workspace, "3.1-outline.json")),
    readJson(path.join(fixture.workspace, "runtime", "dialogue-translate", "manifest.json")),
    readJson(path.join(fixture.workspace, "review-scorecard.json")),
    readJson(path.join(fixture.workspace, "runtime", "review-source-index.json")),
    readJson(path.join(fixture.workspace, "runtime", "review-coverage.json")),
    readJson(path.join(fixture.workspace, "runtime", "review-ledger.json")),
    readJson(path.join(fixture.workspace, "runtime", "review-scoring.json")),
    readJson(path.join(fixture.workspace, "1.2-project-progress.json")),
    fs.readFile(path.join(fixture.workspace, "output", "审稿报告.md"), "utf8")
  ]);
  assert.equal(input.project.project_name, "失控证据");
  assert.equal(outline["剧本名称"], "失控证据");
  assert.equal(outline["英文剧本名称"], "Evidence Unbound");
  assert.deepEqual(manifest, {
    source_file: nextFullPath,
    source_hash: hashText(nextFullText),
    output_file: nextDialoguePath,
    output_heading: "# 失控证据 - 台词译稿"
  });
  assert.equal(scorecard["剧本信息"]["剧本名称"], "失控证据");
  assert.equal(scorecard["审稿信息"]["剧本文件"], nextDialoguePath);
  assert.equal(scorecard["审稿信息"]["剧本哈希"], hashText(nextDialogueText));
  assert.deepEqual(scorecard["审稿信息"]["可用材料"], [nextFullPath, nextDialoguePath]);
  [index, coverage, ledger].forEach((value) => assert.equal(value.script_hash, hashText(nextDialogueText)));
  assert.equal(index.script_path, nextDialoguePath);
  assert.equal(scoring["剧本哈希"], hashText(nextDialogueText));
  assert.match(report, /^# 《失控证据》审稿报告/mu);
  assert.match(report, /- 剧集名称：失控证据/u);
  assert.deepEqual(progress.stages.outline_rewrite.output_files, ["3.1-outline.json", nextOutlinePath]);
  assert.deepEqual(progress.stages.outline_rewrite.title_confirmation, {
    status: "confirmed",
    title: "失控证据",
    english_title: "Evidence Unbound"
  });
  assert.deepEqual(progress.stages.full_generate.output_files, [nextFullPath]);
  assert.deepEqual(progress.stages.dialogue_translate.output_files, [nextDialoguePath]);
  assert.equal(progress.stages.foreign_review.review_decision.artifact_hashes[nextDialoguePath], hashText(nextDialogueText));
  assert.equal(progress.stages.foreign_review.review_decision.artifact_hashes["review-scorecard.json"], hashText(JSON.stringify(scorecard, null, 2) + "\n"));
});

test("名称冲突会在写入前中止，原有文件保持不变", async (t) => {
  const fixture = await createWorkspace();
  t.after(() => fs.rm(fixture.workspace, { recursive: true, force: true }));
  const targetOutline = { ...fixture.outline, "剧本名称": "失控证据", "英文剧本名称": "Evidence Unbound" };
  const conflictPath = path.join(fixture.workspace, outlineDocumentRelativePath(targetOutline));
  await fs.writeFile(conflictPath, "# 已存在\n", "utf8");

  await assert.rejects(
    renameScriptTitle({ workspace: fixture.workspace, title: "失控证据", englishTitle: "Evidence Unbound", updatedBy: "rename-test" }),
    /目标文件已存在/u
  );
  assert.equal((await readJson(path.join(fixture.workspace, "3.1-outline.json")))["剧本名称"], "边界追查");
  assert.equal(await fs.readFile(path.join(fixture.workspace, fixture.outlinePath), "utf8"), "# 边界追查 - 故事梗概\n\n测试梗概。\n");
});

test("国内项目无需英文剧本名称，海外项目不能遗漏英文剧本名称", async (t) => {
  const overseas = await createWorkspace();
  const domestic = await createWorkspace();
  t.after(() => Promise.all([
    fs.rm(overseas.workspace, { recursive: true, force: true }),
    fs.rm(domestic.workspace, { recursive: true, force: true })
  ]));

  await assert.rejects(
    renameScriptTitle({ workspace: overseas.workspace, title: "失控证据", updatedBy: "rename-test" }),
    /海外项目缺少英文剧本名称/u
  );

  const domesticInputPath = path.join(domestic.workspace, "1.1-user-input.json");
  const domesticInput = await readJson(domesticInputPath);
  domesticInput.project.target_region = "国内";
  domesticInput.project.requires_translation = false;
  await writeJson(domesticInputPath, domesticInput);

  const result = await renameScriptTitle({
    workspace: domestic.workspace,
    title: "失控证据",
    englishTitle: "",
    updatedBy: "rename-test"
  });
  const outline = await readJson(path.join(domestic.workspace, "3.1-outline.json"));

  assert.equal(result.english_title, "");
  assert.equal(outline["剧本名称"], "失控证据");
  assert.equal(outline["英文剧本名称"], "");
});

test("非剧本改写项目不能通过剧名同步工具改名", async (t) => {
  const fixture = await createWorkspace();
  t.after(() => fs.rm(fixture.workspace, { recursive: true, force: true }));
  fixture.userInput.project.task_type = "novel";
  await writeJson(path.join(fixture.workspace, "1.1-user-input.json"), fixture.userInput);

  await assert.rejects(
    renameScriptTitle({ workspace: fixture.workspace, title: "失控证据", updatedBy: "rename-test" }),
    /剧本名称只能在剧本改写项目的故事梗概中维护/u
  );
});
