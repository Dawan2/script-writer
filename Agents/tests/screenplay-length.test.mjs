import assert from "node:assert/strict";
import test from "node:test";
import { screenplayLengthContract } from "../.claude/tools/screenplay-length.mjs";

test("90 秒单集的中文可拍正文下限为 600 字", () => {
  assert.deepEqual(
    screenplayLengthContract({ project: { distribution_brief: {} } }),
    { episode_duration_seconds: 90, minimum_episode_characters: 600 }
  );
  assert.deepEqual(
    screenplayLengthContract({ project: { distribution_brief: { episode_duration: "120 秒" } } }),
    { episode_duration_seconds: 120, minimum_episode_characters: 800 }
  );
});
