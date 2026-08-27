#!/usr/bin/env node
import { pathToFileURL } from "node:url";


export class NovelReadingToolError extends Error {
  constructor(message, nextAction) {
    super(message);
    this.nextAction = nextAction;
  }
}


export async function completeNovelReading({
  endpoint = process.env.ORCA_NOVEL_ANALYSIS_TOOL_URL,
  token = process.env.ORCA_NOVEL_ANALYSIS_TOOL_TOKEN,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!endpoint || !token || typeof fetchImpl !== "function") {
    throw new NovelReadingToolError(
      "当前任务没有可用的小说全文阅读上下文。",
      "请重新执行小说解读，不要手动读取全文。"
    );
  }
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "x-agent-tool-token": token }
    });
  } catch {
    throw new NovelReadingToolError(
      "小说全文阅读服务暂时无法连接。",
      "稍后重新调用‘完整阅读小说’。"
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.detail && typeof payload.detail === "object" ? payload.detail : payload;
    throw new NovelReadingToolError(
      String(detail?.message || "小说全文阅读未完成。"),
      String(detail?.next_action || "根据错误信息修复后重新调用。")
    );
  }
  if (payload?.ok !== true || !String(payload?.next_action || "").trim()) {
    throw new NovelReadingToolError(
      "小说全文阅读没有返回有效结果。",
      "重新调用‘完整阅读小说’。"
    );
  }
  return {
    ok: true,
    message: "小说全文阅读已启动。",
    next_action: "全文阅读正在由系统完成。立即结束本轮，不要等待、轮询或再次调用‘完整阅读小说’。"
  };
}


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await completeNovelReading();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      message: error.message,
      next_action: error.nextAction || "重新执行小说解读。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
