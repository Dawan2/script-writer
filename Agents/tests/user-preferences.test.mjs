import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getUserPreferences } from "../.claude/tools/get-user-preferences.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacesRoot = path.join(agentsRoot, "workspaces");

async function createWorkspace(t) {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(workspacesRoot, "user-preferences-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("读取用户偏好只返回文本和可读附件", async (t) => {
  const workspace = await createWorkspace(t);
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspace, "1.1-user-input.json"), JSON.stringify({
    project: {
      extra_requirements: "强化主角的主动选择。",
      stage_preferences: {
        trial_generate: ["每集结尾保留明确问题。", "每集结尾保留明确问题。"]
      },
      distribution_brief: { maturity_target: "不应返回" },
      attachments: [
        {
          original_name: "人物设定.pdf",
          reference_path: "references/人物设定.pdf",
          text_path: "references/人物设定-文本.md",
          text_status: "available"
        },
        {
          original_name: "图片参考.png",
          reference_path: "references/图片参考.png",
          text_path: "",
          text_status: "unsupported"
        },
        {
          original_name: "转换失败.docx",
          reference_path: "references/转换失败.docx",
          text_path: "references/转换失败-文本.md",
          text_status: "unavailable"
        }
      ]
    }
  }, null, 2), "utf8");
  await fs.writeFile(path.join(workspace, "memory", "stage-preferences.json"), JSON.stringify({
    preferences: {
      trial_generate: [
        "只写可拍动作。",
        { content: "强化主角的主动选择。", source: "manual" }
      ]
    }
  }, null, 2), "utf8");

  const result = await getUserPreferences(workspace, "trial_generate");
  assert.deepEqual(result, {
    preferences: ["强化主角的主动选择。", "每集结尾保留明确问题。", "只写可拍动作。"],
    attachments: [{ original_name: "人物设定.pdf", text_path: "references/人物设定-文本.md" }]
  });
  const serialized = JSON.stringify(result);
  ["workspace_dir", "stage", "maturity_target", "reference_path", "text_status", "source"].forEach((field) => {
    assert.equal(serialized.includes(field), false, `不应返回 ${field}`);
  });
});
