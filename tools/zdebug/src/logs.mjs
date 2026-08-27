import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function projectIdFromPath(projectPath) {
  return path.resolve(projectPath).replace(/[\/\\_:\s]/g, "-").replace(/[^\x00-\x7F]/g, "-");
}

export function resolveClaudeLogDir(projectDir, explicitLogDir) {
  if (explicitLogDir) return path.resolve(explicitLogDir);
  return path.join(os.homedir(), ".claude", "projects", projectIdFromPath(projectDir));
}

export async function listLogFiles(logDir) {
  let entries = [];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => {
      const filePath = path.join(logDir, entry.name);
      const stat = await fs.stat(filePath);
      return {
        id: entry.name.replace(/\.jsonl$/, ""),
        name: entry.name,
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    }));

  return files.sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime());
}

function manifestDate(value, fallback) {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

async function listManifestWorkerLogs(entries, parentId) {
  if (!Array.isArray(entries)) return [];
  const ids = new Set();
  const workers = await Promise.all(entries.map(async (entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid worker log entry at index ${index} for ${parentId}`);
    }
    const id = String(entry.id || "").trim();
    const name = String(entry.name || "").trim();
    const declaredPath = String(entry.path || "").trim();
    if (!id || !name || !declaredPath || ids.has(id)) {
      throw new Error(`Invalid or duplicate worker log entry at index ${index} for ${parentId}`);
    }
    ids.add(id);
    const filePath = path.resolve(declaredPath);
    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      stat = null;
    }
    if (!stat && !entry.live) return null;
    const fallbackDate = stat?.mtime || new Date();
    return {
      id,
      name,
      tag: String(entry.tag || "").trim(),
      path: filePath,
      size: stat?.size || 0,
      modifiedAt: manifestDate(entry.modifiedAt, fallbackDate),
      live: Boolean(entry.live),
      workerNumber: Number(entry.workerNumber || 0) || null,
      sessionId: String(entry.sessionId || ""),
    };
  }));
  return workers.filter(Boolean).sort((left, right) => {
    const leftNumber = left.workerNumber ?? Number.MAX_SAFE_INTEGER;
    const rightNumber = right.workerNumber ?? Number.MAX_SAFE_INTEGER;
    return leftNumber - rightNumber || new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime();
  });
}

export async function listManifestLogFiles(manifestPath) {
  const resolvedManifestPath = path.resolve(manifestPath);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(resolvedManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ZDebug log manifest ${resolvedManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload?.version !== 1 || !Array.isArray(payload.files)) {
    throw new Error(`Invalid ZDebug log manifest: ${resolvedManifestPath}`);
  }

  const ids = new Set();
  const files = await Promise.all(payload.files.map(async (entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid ZDebug log manifest entry at index ${index}`);
    }
    const id = String(entry.id || "").trim();
    const name = String(entry.name || "").trim();
    const declaredPath = String(entry.path || "").trim();
    if (!id || !name || !declaredPath || ids.has(id)) {
      throw new Error(`Invalid or duplicate ZDebug log manifest entry at index ${index}`);
    }
    ids.add(id);
    const filePath = path.resolve(declaredPath);
    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      stat = null;
    }
    if (!stat && !entry.live) return null;
    const fallbackDate = stat?.mtime || new Date();
    return {
      id,
      name,
      tag: String(entry.tag || "").trim(),
      path: filePath,
      size: stat?.size || 0,
      modifiedAt: manifestDate(entry.modifiedAt, fallbackDate),
      live: Boolean(entry.live),
      current: Boolean(entry.current),
      jobId: entry.jobId ?? null,
      sessionId: String(entry.sessionId || ""),
      workers: await listManifestWorkerLogs(entry.workers, id),
    };
  }));

  return files
    .filter(Boolean)
    .sort((left, right) => {
      const timeDifference = new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime();
      return timeDifference || Number(right.jobId || 0) - Number(left.jobId || 0);
    });
}

export async function readJsonlFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          type: "parse_error",
          timestamp: new Date().toISOString(),
          raw: line,
          index,
        };
      }
    });
}

export async function readJsonlChunk(filePath, options = {}) {
  const offset = Math.max(0, Number(options.offset || 0));
  const maxBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(options.maxBytes || 1024 * 1024)));
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) return { entries: [], offset, nextOffset: offset, size: stat.size };
    const length = Math.min(maxBytes, stat.size - offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const atEnd = offset + bytesRead >= stat.size;
    const lastNewline = text.lastIndexOf("\n");
    const completeText = atEnd ? text : (lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "");
    const nextOffset = offset + Buffer.byteLength(completeText);
    const entries = completeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", timestamp: new Date().toISOString(), raw: line, index };
      }
    });
    return { entries, offset, nextOffset, size: stat.size };
  } finally {
    await handle.close();
  }
}
