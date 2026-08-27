import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializePreferenceSummary } from "../.claude/skills/preference-summary/scripts/init-preference-summary.mjs";
import { validatePreferenceSummary } from "../.claude/skills/preference-summary/scripts/validate-preference-summary.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "preference-summary-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("偏好复盘只接受手工证据引用，并保留待确认结果契约", async (t) => {
  const directory = await temporaryDirectory(t);
  const evidencePath = path.join(directory, "evidence.json");
  const outputPath = path.join(directory, "result.json");
  await fs.writeFile(evidencePath, JSON.stringify({
    schema_version: "1.0.0",
    manual_inputs: [],
    manual_messages: [{ ref: "message:7", stage: "trial_generate", content: "反转必须由人物行动触发" }],
    manual_adjustments: [{ ref: "artifact_change:8", stage: "trial_generate", summary: "用户删掉了突然揭晓" }]
  }), "utf8");

  await initializePreferenceSummary({ evidencePath, outputPath });
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), {
    schema_version: "1.0.0",
    preferences: []
  });

  await fs.writeFile(outputPath, JSON.stringify({
    schema_version: "1.0.0",
    preferences: [{
      content: "试稿中的反转应由人物可观察的行动引发。",
      scopes: ["trial_generate"],
      evidence_refs: ["message:7", "artifact_change:8"],
      rationale: "用户的明确要求与手工删改方向一致。"
    }]
  }), "utf8");
  assert.equal((await validatePreferenceSummary({ evidencePath, outputPath })).ok, true);

  await fs.writeFile(outputPath, JSON.stringify({
    schema_version: "1.0.0",
    preferences: [{
      content: "无来源规则",
      scopes: ["global"],
      evidence_refs: ["event:99"],
      rationale: "错误示例。"
    }]
  }), "utf8");
  const invalid = await validatePreferenceSummary({ evidencePath, outputPath });
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.join("；"), /非手工/u);
});
