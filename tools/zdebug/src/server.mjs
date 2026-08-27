import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import fs from "node:fs/promises";
import { listLogFiles, listManifestLogFiles, readJsonlChunk, readJsonlFile, resolveClaudeLogDir } from "./logs.mjs";
import { parseEntries } from "./parser.mjs";

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageHtml(config) {
  const sourceLabel = config.logManifest ? `当前任务日志 · ${config.logManifest}` : config.logDir;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ZDebug</title>
  <style>
    :root { color-scheme: light; --line:#d9e3ea; --ink:#10212b; --muted:#6c7a85; --paper:#f8fbfc; --panel:#ffffff; --blue:#0d6b86; --mint:#1b8f71; --red:#c74e45; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:12px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { align-items:center; background:var(--panel); border-bottom:1px solid var(--line); display:grid; grid-template-columns:minmax(12rem,1fr) minmax(18rem,34rem) minmax(9rem,11rem) auto; gap:10px; min-height:48px; padding:8px 12px; position:sticky; top:0; z-index:2; }
    header > div { min-width:0; }
    h1 { color:var(--blue); font-size:15px; margin:0; }
    .meta { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    select, button { background:var(--panel); border:1px solid var(--line); color:var(--ink); height:30px; padding:0 9px; }
    #fileSelect, #processFilter { min-width:0; width:100%; }
    button { cursor:pointer; }
    main { display:grid; gap:10px; padding:10px; }
    .status { color:var(--muted); min-height:18px; }
    .timeline { background:var(--panel); border:1px solid var(--line); }
    .step { border-bottom:1px solid var(--line); display:grid; grid-template-columns:48px 96px 120px minmax(0,1fr) 72px; min-height:38px; }
    .step:last-child { border-bottom:0; }
    .idx, .kind { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; padding:10px 8px; }
    .kind { color:var(--blue); }
    .process-tag { align-self:start; color:var(--mint); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; padding:10px 4px; white-space:nowrap; }
    .kind.tool_call, .kind.agent_child, .kind.tool_result { color:var(--mint); }
    .kind.error { color:var(--red); }
    .time { align-self:start; color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; font-variant-numeric:tabular-nums; justify-self:end; padding:10px 8px; white-space:nowrap; }
    details { min-width:0; padding:8px 10px; }
    summary { cursor:pointer; list-style:none; min-width:0; }
    summary::-webkit-details-marker { display:none; }
    .title { font-weight:650; margin-right:8px; }
    .desc { color:var(--muted); overflow-wrap:anywhere; }
    pre { background:#f2f6f8; border:1px solid var(--line); color:#23333c; font:11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin:8px 0 0; max-height:420px; overflow:auto; padding:10px; white-space:pre-wrap; }
    .raw-toggle { margin-top:8px; padding:0; }
    .raw-toggle summary { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:10px; }
    .raw-toggle pre { max-height:260px; }
    .empty { align-items:center; color:var(--muted); display:flex; justify-content:center; min-height:180px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>ZDebug</h1>
      <div class="meta" id="project">${escapeHtml(config.projectDir)} · ${escapeHtml(sourceLabel)}${config.runtimeLog ? ` · live ${escapeHtml(config.runtimeLog)}` : ""}</div>
    </div>
    <select id="fileSelect" aria-label="日志文件"></select>
    <select id="processFilter" aria-label="进程筛选"></select>
    <button id="refresh">刷新</button>
  </header>
  <main>
    <div class="status" id="status">正在读取日志...</div>
    <section class="timeline" id="timeline"><div class="empty">加载中</div></section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const configuredSelectedLogId = ${JSON.stringify(config.selectedLogId || "")};
    const preferredLogId = params.get("logid") || params.get("logId") || configuredSelectedLogId;
    const preferredSessionId = params.get("sessionid") || params.get("sessionId") || "";
    const fileSelect = document.getElementById("fileSelect");
    const processFilter = document.getElementById("processFilter");
    const statusEl = document.getElementById("status");
    const timeline = document.getElementById("timeline");
    let files = [];
    let refreshTimer = 0;
    let openedStepIds = new Set();
    let lastRenderSignature = "";
    let loadedSteps = [];
    let loadedProcesses = [];
    const fileCursors = new Map();
    const basePath = location.pathname.endsWith("/") ? location.pathname : location.pathname + "/";
    const apiPath = (path) => basePath + path;
    async function fetchJson(url) {
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || response.statusText);
      return body.data;
    }
    function stepsSignature(steps) {
      const last = steps.at(-1);
      return JSON.stringify({
        count: steps.length,
        lastId: last?.id || "",
        lastRawLength: String(last?.raw || "").length,
        lastSummary: last?.summary || "",
        lastTimestamp: last?.timestamp || "",
      });
    }
    function processFilterLabel(process) {
      if (process.id === "all") return "全部进程";
      if (process.id === "main") return "主进程";
      return '[' + (process.tag || "子进程") + '] ' + process.name;
    }
    function syncProcessFilter(processes) {
      const current = processFilter.value || "all";
      loadedProcesses = processes?.length ? processes : [{ id: "all", name: "全部进程" }];
      processFilter.innerHTML = loadedProcesses.map((process) => '<option value="' + escapeHtml(process.id) + '">' + escapeHtml(processFilterLabel(process)) + '</option>').join('');
      processFilter.value = loadedProcesses.some((process) => process.id === current) ? current : "all";
    }
    function visibleSteps() {
      const processId = processFilter.value || "all";
      return processId === "all" ? loadedSteps : loadedSteps.filter((step) => step.process?.id === processId);
    }
    function renderVisibleSteps(options = {}) {
      renderSteps(visibleSteps(), options);
    }
    function fileOptionLabel(file) {
      const tag = file.tag ? '[' + file.tag + '] ' : '';
      return tag + file.name + ' · ' + new Date(file.modifiedAt).toLocaleString();
    }
    function captureScrollState() {
      const state = {
        windowY: window.scrollY,
        pres: {},
      };
      for (const article of timeline.querySelectorAll('article.step')) {
        const stepId = article.dataset.stepId;
        if (!stepId) continue;
        state.pres[stepId] = Array.from(article.querySelectorAll('pre')).map((pre) => ({
          top: pre.scrollTop,
          left: pre.scrollLeft,
        }));
      }
      return state;
    }
    function restoreScrollState(state) {
      if (!state) return;
      for (const article of timeline.querySelectorAll('article.step')) {
        const stepId = article.dataset.stepId;
        const positions = stepId ? state.pres[stepId] : null;
        if (!positions) continue;
        Array.from(article.querySelectorAll('pre')).forEach((pre, index) => {
          const position = positions[index];
          if (!position) return;
          pre.scrollTop = position.top;
          pre.scrollLeft = position.left;
        });
      }
      window.scrollTo({ top: state.windowY, behavior: 'auto' });
    }
    function renderSteps(steps, options = {}) {
      const signature = stepsSignature(steps);
      if (options.silent && signature === lastRenderSignature) return;
      const scrollState = captureScrollState();
      if (!steps.length) {
        timeline.innerHTML = '<div class="empty">暂无可展示的步骤</div>';
        lastRenderSignature = signature;
        return;
      }
      timeline.innerHTML = steps.map((step) => {
        const rawStepId = step.id || String(step.index);
        const stepId = escapeHtml(rawStepId);
        const idx = step.stepNumber ? '#' + step.stepNumber : '';
        const details = escapeHtml(step.details || '');
        const raw = escapeHtml(step.raw || '');
        const summary = escapeHtml(step.summary || '');
        const timestamp = formatTimestamp(step.timestamp);
        const timestampTitle = formatTimestampTitle(step.timestamp);
        const openAttr = openedStepIds.has(rawStepId) ? ' open' : '';
        const rawBlock = raw ? '<details class="raw-toggle"><summary>原始记录</summary><pre>' + raw + '</pre></details>' : '';
        const processTag = step.process?.tag ? '<div class="process-tag">[' + escapeHtml(step.process.tag) + ']</div>' : '<div class="process-tag"></div>';
        return '<article class="step" data-step-id="' + stepId + '">' +
          '<div class="idx">' + idx + '</div>' +
          processTag +
          '<div class="kind ' + escapeHtml(step.type) + '">' + escapeHtml(step.type === 'preparation' ? '任务准备' : step.type) + '</div>' +
          '<details' + openAttr + '>' +
          '<summary><span class="title">' + escapeHtml(step.title) + '</span><span class="desc">' + summary + '</span></summary>' +
          '<pre>' + details + '</pre>' +
          rawBlock +
          '</details>' +
          (timestamp ? '<time class="time" datetime="' + escapeHtml(step.timestamp) + '" title="' + escapeHtml(timestampTitle) + '">' + escapeHtml(timestamp) + '</time>' : '') +
          '</article>';
      }).join('');
      lastRenderSignature = signature;
      restoreScrollState(scrollState);
    }
    async function loadFiles() {
      const data = await fetchJson(apiPath('api/files'));
      files = data.files || [];
      fileSelect.innerHTML = files.map((file) => '<option value="' + escapeHtml(file.id) + '">' + escapeHtml(fileOptionLabel(file)) + '</option>').join('');
      const preferred = files.find((file) => file.id === preferredLogId)
        || files.find((file) => file.current && file.sessionId === preferredSessionId)
        || files.find((file) => file.sessionId === preferredSessionId);
      fileSelect.value = preferred ? preferred.id : (files[0]?.id || '');
      statusEl.textContent = files.length ? '找到 ' + files.length + ' 个当前任务日志' : '当前任务暂无可展示日志';
      if (fileSelect.value) await loadSelected();
      else renderSteps([]);
    }
    async function loadSelected(options = {}) {
      const fileId = fileSelect.value;
      if (!fileId) return;
      if (!options.silent) statusEl.textContent = '正在读取 ' + fileId + '...';
      const cursor = fileCursors.get(fileId) || 0;
      const data = await fetchJson(apiPath('api/files/' + encodeURIComponent(fileId)) + '?cursor=' + cursor);
      fileCursors.set(fileId, data.cursor || 0);
      loadedSteps = data.steps || [];
      syncProcessFilter(data.processes || []);
      renderVisibleSteps(options);
      const hiddenText = data.hiddenCount ? ' · 已隐藏 ' + data.hiddenCount + ' 条内部事件' : '';
      const tagText = data.file.tag ? ' · [' + data.file.tag + ']' : '';
      statusEl.textContent = data.steps.length + ' 个可读步骤 · ' + data.file.name + tagText + hiddenText + (data.file.live ? ' · 实时刷新中' : '');
    }
    timeline.addEventListener('toggle', (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const stepId = details.closest('article.step')?.dataset.stepId;
      if (!stepId) return;
      if (details.open) openedStepIds.add(stepId);
      else openedStepIds.delete(stepId);
    }, true);
    fileSelect.addEventListener('change', () => {
      openedStepIds = new Set();
      lastRenderSignature = "";
      loadSelected().catch((error) => statusEl.textContent = error.message);
    });
    processFilter.addEventListener('change', () => {
      lastRenderSignature = "";
      renderVisibleSteps();
    });
    document.getElementById('refresh').addEventListener('click', () => loadFiles().catch((error) => statusEl.textContent = error.message));
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    }
    function parseTimestamp(value) {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    function formatTimestamp(value) {
      const date = parseTimestamp(value);
      if (!date) return '';
      return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(date);
    }
    function formatTimestampTitle(value) {
      const date = parseTimestamp(value);
      if (!date) return '';
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(date);
    }
    loadFiles().catch((error) => {
      statusEl.textContent = error.message;
      timeline.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
    refreshTimer = window.setInterval(() => {
      if (fileSelect.value) loadSelected({ silent: true }).catch((error) => statusEl.textContent = error.message);
    }, 1500);
  </script>
</body>
</html>`;
}

async function runtimeLogFile(config) {
  if (!config.runtimeLog) return null;
  const filePath = path.resolve(config.runtimeLog);
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    stat = null;
  }
  return {
    id: config.sessionId || path.basename(filePath).replace(/\.jsonl$/, ""),
    name: config.runtimeName || `当前运行日志 · ${config.sessionId || path.basename(filePath)}`,
    path: filePath,
    size: stat?.size || 0,
    modifiedAt: (stat?.mtime || new Date()).toISOString(),
    live: true,
  };
}

export async function listFiles(config) {
  if (config.logManifest) {
    return listManifestLogFiles(config.logManifest);
  }
  const files = await listLogFiles(config.logDir);
  const liveFile = await runtimeLogFile(config);
  if (!liveFile) return files;
  return [
    liveFile,
    ...files.filter((file) => file.path !== liveFile.path && file.id !== liveFile.id),
  ];
}

export function processSources(file) {
  return [
    {
      id: "main",
      name: "主进程",
      tag: "",
      path: file.path,
      size: file.size,
      live: file.live,
    },
    ...(file.workers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      tag: worker.tag,
      path: worker.path,
      size: worker.size,
      live: worker.live,
    })),
  ];
}

export function processFilters(file) {
  return [
    { id: "all", name: "全部进程", tag: "" },
    ...processSources(file).map((source) => ({ id: source.id, name: source.name, tag: source.tag })),
  ];
}

function entryTimestamp(entry) {
  const value = Date.parse(entry?.timestamp || entry?.created_at || "");
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

export function mergeProcessEntries(sources, sourceEntries) {
  const entries = sourceEntries.flatMap((items, sourceIndex) => items.map((entry, entryIndex) => ({
    entry: {
      ...entry,
      zdebug_process: {
        id: sources[sourceIndex].id,
        name: sources[sourceIndex].name,
        tag: sources[sourceIndex].tag,
      },
    },
    sourceIndex,
    entryIndex,
  })));
  entries.sort((left, right) => {
    const timeDifference = entryTimestamp(left.entry) - entryTimestamp(right.entry);
    return timeDifference || left.sourceIndex - right.sourceIndex || left.entryIndex - right.entryIndex;
  });
  return entries.map((item) => item.entry);
}

export async function startServer(config) {
  const projectDir = path.resolve(config.projectDir || process.cwd());
  const logManifest = config.logManifest ? path.resolve(config.logManifest) : "";
  const logDir = logManifest ? "" : resolveClaudeLogDir(projectDir, config.logDir);
  const runtimeLog = config.runtimeLog ? path.resolve(config.runtimeLog) : "";
  const runtimeName = config.runtimeName || "";
  const sessionId = config.sessionId || "";
  const selectedLogId = config.selectedLogId || "";
  const host = config.host || "127.0.0.1";
  const port = Number(config.port || 4301);
  const fileConfig = { logDir, logManifest, runtimeLog, runtimeName, sessionId };
  const entryCache = new Map();

  async function cachedEntries(source) {
    if (!source.live) return { entries: await readJsonlFile(source.path), cursor: source.size };
    let cached = entryCache.get(source.path);
    if (!cached || source.size < cached.offset) cached = { entries: [], offset: 0 };
    while (cached.offset < source.size) {
      const chunk = await readJsonlChunk(source.path, { offset: cached.offset, maxBytes: 4 * 1024 * 1024 });
      if (chunk.nextOffset <= cached.offset) break;
      cached.entries.push(...chunk.entries);
      cached.offset = chunk.nextOffset;
    }
    entryCache.set(source.path, cached);
    return { entries: cached.entries, cursor: cached.offset };
  }

  async function mergedEntries(file) {
    const sources = processSources(file);
    const collected = await Promise.all(sources.map(async (source) => {
      try {
        const cached = await cachedEntries(source);
        return cached.entries;
      } catch (error) {
        if (source.live) return [];
        throw error;
      }
    }));
    return {
      entries: mergeProcessEntries(sources, collected),
      cursor: sources.reduce((total, source) => total + Number(source.size || 0), 0),
      processes: processFilters(file),
    };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" });
        response.end();
        return;
      }
      if (url.pathname === "/api/project") {
        sendJson(response, 200, { success: true, data: { projectDir, logDir, logManifest, runtimeLog, selectedLogId } });
        return;
      }
      if (url.pathname === "/api/files") {
        const files = await listFiles(fileConfig);
        sendJson(response, 200, { success: true, data: { files, logDir, logManifest, runtimeLog, selectedLogId } });
        return;
      }
      if (url.pathname.startsWith("/api/files/")) {
        const fileId = decodeURIComponent(url.pathname.slice("/api/files/".length));
        const files = await listFiles(fileConfig);
        const file = files.find((item) => item.id === fileId || item.name === fileId || item.name === `${fileId}.jsonl`);
        if (!file) {
          sendJson(response, 404, { success: false, error: `Log file not found: ${fileId}` });
          return;
        }
        let entries = [];
        let cursor = 0;
        let processes = processFilters(file);
        try {
          const merged = await mergedEntries(file);
          entries = merged.entries;
          cursor = merged.cursor;
          processes = merged.processes;
        } catch (error) {
          if (!file.live) throw error;
        }
        const steps = parseEntries(entries);
        sendJson(response, 200, { success: true, data: { file, steps, processes, cursor, hiddenCount: steps.hiddenCount || 0 } });
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(pageHtml({ projectDir, logDir, logManifest, runtimeLog, selectedLogId }));
    } catch (error) {
      sendJson(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  return server;
}
