import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listFiles, mergeProcessEntries, processFilters, processSources } from "./server.mjs";
import { readJsonlChunk } from "./logs.mjs";

test("manifest mode returns only task-owned job logs and keeps duplicate sessions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zdebug-manifest-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const logDir = path.join(root, "global");
  await fs.mkdir(logDir);
  const firstLog = path.join(root, "agent_job_35.jsonl");
  const secondLog = path.join(root, "agent_job_36.jsonl");
  const unrelatedLog = path.join(logDir, "unrelated-session.jsonl");
  await Promise.all([
    fs.writeFile(firstLog, '{"type":"result","result":"first"}\n'),
    fs.writeFile(secondLog, '{"type":"result","result":"second"}\n'),
    fs.writeFile(unrelatedLog, '{"type":"result","result":"unrelated"}\n'),
  ]);
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    scope: { type: "project", projectId: 7 },
    selectedLogId: "job-36",
    files: [
      {
        id: "job-35",
        jobId: 35,
        sessionId: "same-session",
        name: "剧本试稿 · trial_generate",
        path: firstLog,
        modifiedAt: "2026-07-11T10:00:00Z",
      },
      {
        id: "job-36",
        jobId: 36,
        sessionId: "same-session",
        name: "剧本试稿 · 重新调整第一章对话",
        path: secondLog,
        modifiedAt: "2026-07-11T11:00:00Z",
        current: true,
        live: true,
        workers: [
          {
            id: "worker:trial-dialogue-review-1",
            name: "台词语义审读",
            tag: "子进程 1",
            workerNumber: 1,
            path: secondLog,
            modifiedAt: "2026-07-11T11:00:00Z",
            live: true,
          },
        ],
      },
    ],
  }));

  const files = await listFiles({ logManifest: manifestPath, logDir });

  assert.deepEqual(files.map((file) => file.id), ["job-36", "job-35"]);
  assert.deepEqual(files.map((file) => file.sessionId), ["same-session", "same-session"]);
  assert.ok(files.every((file) => file.path !== unrelatedLog));
  assert.equal(files[0].current, true);
  assert.equal(files[0].workers[0].tag, "子进程 1");
});

test("manifest mode omits missing archived logs but preserves a missing live log", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zdebug-live-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    files: [
      {
        id: "job-1",
        name: "故事梗概 · outline_rewrite",
        path: path.join(root, "missing-archived.jsonl"),
        modifiedAt: "2026-07-11T09:00:00Z",
      },
      {
        id: "job-2",
        name: "人物小传 · character_rewrite",
        path: path.join(root, "missing-live.jsonl"),
        modifiedAt: "2026-07-11T10:00:00Z",
        live: true,
      },
    ],
  }));

  const files = await listFiles({ logManifest: manifestPath, logDir: path.join(root, "unused") });

  assert.deepEqual(files.map((file) => file.id), ["job-2"]);
  assert.equal(files[0].size, 0);
});

test("worker entries merge into the parent timeline with stable process tags", () => {
  const file = {
    path: "/tmp/main.jsonl",
    size: 1,
    live: true,
    workers: [{
      id: "worker:trial-dialogue-review-1",
      name: "台词语义审读",
      tag: "子进程 1",
      path: "/tmp/worker.jsonl",
      size: 1,
      live: true,
    }],
  };
  const sources = processSources(file);
  const entries = mergeProcessEntries(sources, [
    [{ type: "assistant", timestamp: "2026-07-11T10:00:02Z", message: { content: [] } }],
    [{ type: "assistant", timestamp: "2026-07-11T10:00:01Z", message: { content: [] } }],
  ]);

  assert.deepEqual(entries.map((entry) => entry.zdebug_process.tag), ["子进程 1", ""]);
  assert.deepEqual(processFilters(file).map((process) => process.id), ["all", "main", "worker:trial-dialogue-review-1"]);
});

test("manifest rejects duplicate file ids instead of selecting ambiguously", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zdebug-duplicate-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "job.jsonl");
  await fs.writeFile(logPath, "{}\n");
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    files: [
      { id: "job-1", name: "first", path: logPath },
      { id: "job-1", name: "second", path: logPath },
    ],
  }));

  await assert.rejects(
    () => listFiles({ logManifest: manifestPath, logDir: root }),
    /duplicate ZDebug log manifest entry/,
  );
});

test("JSONL cursor only reads newly completed lines", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zdebug-cursor-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "live.jsonl");
  await fs.writeFile(logPath, '{"type":"system"}\n{"type":"assistant"}\n');
  const first = await readJsonlChunk(logPath, { maxBytes: 1024 });
  assert.equal(first.entries.length, 2);
  await fs.appendFile(logPath, '{"type":"result"}\n');
  const second = await readJsonlChunk(logPath, { offset: first.nextOffset, maxBytes: 1024 });
  assert.deepEqual(second.entries.map(({ type }) => type), ["result"]);
  assert.equal(second.nextOffset > first.nextOffset, true);
});
