import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getRegionRules, resolveRegionRules } from "../.claude/tools/get-region-rules.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacesRoot = path.join(agentsRoot, "workspaces");

async function createWorkspace(t) {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(workspacesRoot, "region-rules-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), JSON.stringify({
    project: {
      target_region: "北美",
      distribution_brief: { target_countries: ["美国"], target_locale: "en-US" }
    }
  }), "utf8");
  return path.relative(agentsRoot, workspace);
}

test("地区规则仅在台词翻译阶段返回翻译语境", async (t) => {
  const workspace = await createWorkspace(t);
  const worldViewRules = await getRegionRules({ workspace, stage: "world_view" });
  assert.equal(Object.hasOwn(worldViewRules, "workspace_dir"), false);
  assert.equal(Object.hasOwn(worldViewRules, "translation_context"), false);
  assert.equal(worldViewRules.rules.some((rule) => rule.includes("前三秒") || rule.includes("每15秒")), false);

  const dialogueRules = await getRegionRules({ workspace, stage: "dialogue_translate" });
  assert.equal(Object.hasOwn(dialogueRules, "workspace_dir"), false);
  assert.deepEqual(dialogueRules.translation_context, (await resolveRegionRules("北美")).translation_context);

  const directRules = await getRegionRules({ "target-region": "北美" });
  assert.equal(Object.hasOwn(directRules, "translation_context"), false);
});
