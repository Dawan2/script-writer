import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/server/backend";
import {
  dialogueScriptDeliveryToDocxBuffer,
  dialogueTrialScriptDeliveryToDocxBuffer,
  deliveryDocumentName,
  fullScriptDeliveryToDocxBuffer,
  trialScriptDeliveryToDocxBuffer,
  type ScriptDelivery
} from "@/lib/server/full-script-delivery-docx";
import { markdownToDocxBuffer } from "@/lib/server/markdown-docx";
import { reviewReportToDocxBuffer } from "@/lib/server/review-report-docx";
import type { StageDocument } from "@/lib/types";

type Params = { params: Promise<{ projectId: string; stage: string }> };

export const runtime = "nodejs";
export const maxDuration = 60;

function safeReviewDocxName(file: StageDocument) {
  const scriptName = file.review_scorecard?.basic_info.script_name.trim() || "海外审稿";
  return `${scriptName.replace(/[\\/:*?"<>|]/g, "-")}-审稿报告.docx`;
}

function safeDeliveryName(delivery: ScriptDelivery, deliveryLabel: string) {
  const title = delivery.title.trim() || "完整剧本";
  return `${title.replace(/[\\/:*?"<>|]/g, "-")}-${deliveryLabel}.docx`;
}

function attachmentHeader(fileName: string, fallbackName: string) {
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function recordDownload(
  projectId: string,
  stage: string,
  format: "docx" | "delivery_docx"
) {
  const response = await backendFetch(`/projects/${projectId}/files/${stage}/download-audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format })
  });
  if (!response.ok) {
    throw new Error("导出记录未完成");
  }
}

async function reviewDocx(projectId: string) {
  const sourceResponse = await backendFetch(`/projects/${projectId}/files/foreign_review`);
  if (!sourceResponse.ok) {
    return new Response(await sourceResponse.text(), {
      status: sourceResponse.status,
      headers: { "content-type": sourceResponse.headers.get("content-type") ?? "application/json" }
    });
  }

  try {
    const payload = await sourceResponse.json() as { file: StageDocument };
    if (!payload.file.review_scorecard) {
      return NextResponse.json({ detail: "结构化评分尚未生成，暂时无法导出完整 Word 报告" }, { status: 409 });
    }
    const docx = await reviewReportToDocxBuffer(payload.file.content, payload.file.review_scorecard);
    const fileName = safeReviewDocxName(payload.file);
    await recordDownload(projectId, "foreign_review", "docx");
    return new Response(new Uint8Array(docx), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": attachmentHeader(fileName, "review-report.docx"),
        "content-length": String(docx.byteLength),
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ detail: `Word 审稿报告生成失败：${message}` }, { status: 500 });
  }
}

type ScriptDocxStage = "full_generate" | "trial_generate" | "dialogue_translate" | "humanizer_zh";
type DialogueDeliveryScope = "full" | "trial";

const EPISODE_HEADING_PATTERN = /^#{1,6}[ \t]*(?:第[ \t]*)?\d+[ \t]*(?:集|章)(?=[ \t]*$|[ \t]*[：:])/gm;

function firstTenEpisodeContent(content: string) {
  const headings = Array.from(content.matchAll(EPISODE_HEADING_PATTERN));
  const firstExcludedHeading = headings[10];
  if (!firstExcludedHeading || firstExcludedHeading.index === undefined) return content;
  return `${content.slice(0, firstExcludedHeading.index).trimEnd()}\n`;
}

function trialScopedDelivery(delivery: ScriptDelivery): ScriptDelivery {
  return {
    ...delivery,
    script: {
      ...delivery.script,
      content: firstTenEpisodeContent(delivery.script.content)
    }
  };
}

async function scriptDocx(projectId: string, stage: ScriptDocxStage) {
  const sourceResponse = await backendFetch(`/projects/${projectId}/files/${stage}`);
  if (!sourceResponse.ok) {
    return new Response(await sourceResponse.text(), {
      status: sourceResponse.status,
      headers: { "content-type": sourceResponse.headers.get("content-type") ?? "application/json" }
    });
  }

  try {
    const payload = await sourceResponse.json() as { file: StageDocument };
    const scriptLabel = stage === "trial_generate"
      ? "剧本试稿"
      : stage === "dialogue_translate"
        ? "台词译稿"
        : stage === "humanizer_zh"
          ? "润色剧本"
          : "完整剧本";
    const docx = await markdownToDocxBuffer(payload.file.content, payload.file.name, {
      subject: scriptLabel,
      description: `由${scriptLabel} Markdown 版本导出`
    });
    const fileName = stage === "humanizer_zh"
      ? "剧本润色.docx"
      : payload.file.file_name.replace(/\.md$/i, "") + ".docx";
    await recordDownload(projectId, stage, "docx");
    return new Response(new Uint8Array(docx), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": attachmentHeader(
          fileName,
          stage === "trial_generate"
            ? "trial-script.docx"
            : stage === "dialogue_translate"
              ? "dialogue-translation.docx"
              : stage === "humanizer_zh"
                ? "polished-script.docx"
                : "full-script.docx"
        ),
        "content-length": String(docx.byteLength),
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ detail: `Word 文档生成失败：${message}` }, { status: 500 });
  }
}

async function deliveryEnglishTitle(projectId: string) {
  try {
    const response = await backendFetch(`/projects/${projectId}/files/outline_rewrite`);
    if (!response.ok) return "";
    const payload = await response.json() as { file?: StageDocument };
    return payload.file?.outline_title?.english_title?.trim() ?? "";
  } catch {
    return "";
  }
}

async function scriptDeliveryDocx(
  projectId: string,
  stage: "full_generate" | "trial_generate" | "dialogue_translate",
  dialogueScope: DialogueDeliveryScope = "full"
) {
  const isTrial = stage === "trial_generate";
  const isDialogueTranslation = stage === "dialogue_translate";
  const isTrialDialogueTranslation = isDialogueTranslation && dialogueScope === "trial";
  const deliveryLabel = deliveryDocumentName(
    isTrial ? "trial" : isTrialDialogueTranslation ? "dialogue_trial" : isDialogueTranslation ? "dialogue" : "full"
  );
  const sourceResponse = await backendFetch(
    `/projects/${projectId}/${isTrial ? "trial-script-delivery" : isDialogueTranslation ? `dialogue-script-delivery?scope=${dialogueScope}` : `full-script-delivery?scope=${dialogueScope}`}`
  );
  if (!sourceResponse.ok) {
    return new Response(await sourceResponse.text(), {
      status: sourceResponse.status,
      headers: { "content-type": sourceResponse.headers.get("content-type") ?? "application/json" }
    });
  }

  try {
    const payload = await sourceResponse.json() as { delivery: ScriptDelivery };
    const delivery = {
      ...(dialogueScope === "trial" ? trialScopedDelivery(payload.delivery) : payload.delivery),
      english_title: await deliveryEnglishTitle(projectId)
    };
    const docx = await (isTrial || (stage === "full_generate" && dialogueScope === "trial")
      ? trialScriptDeliveryToDocxBuffer(delivery)
      : isTrialDialogueTranslation
        ? dialogueTrialScriptDeliveryToDocxBuffer(delivery)
        : isDialogueTranslation
        ? dialogueScriptDeliveryToDocxBuffer(delivery)
        : fullScriptDeliveryToDocxBuffer(delivery));
    const fileName = safeDeliveryName(
      delivery,
      stage === "full_generate" && dialogueScope === "trial"
        ? "试稿交付"
        : isTrialDialogueTranslation ? "试稿译稿" : isDialogueTranslation ? "完本译稿" : deliveryLabel
    );
    await recordDownload(projectId, stage, "delivery_docx");
    return new Response(new Uint8Array(docx), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": attachmentHeader(fileName, "final-script-delivery.docx"),
        "content-length": String(docx.byteLength),
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const documentName = isTrial || (stage === "full_generate" && dialogueScope === "trial")
      ? "试稿"
      : isTrialDialogueTranslation ? "试稿译稿" : isDialogueTranslation ? "完本译稿" : "完本";
    return NextResponse.json({ detail: `${documentName} Word 生成失败：${message}` }, { status: 500 });
  }
}

export async function GET(request: Request, context: Params) {
  const { projectId, stage } = await context.params;
  if (stage === "foreign_review") {
    return reviewDocx(projectId);
  }
  if (stage === "full_generate" || stage === "trial_generate" || stage === "dialogue_translate" || stage === "humanizer_zh") {
    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    if (format === "delivery-docx" && (stage === "full_generate" || stage === "trial_generate" || stage === "dialogue_translate")) {
      return scriptDeliveryDocx(projectId, stage, url.searchParams.get("scope") === "trial" ? "trial" : "full");
    }
    if (format === "docx") return scriptDocx(projectId, stage);
  }

  const response = await backendFetch(`/projects/${projectId}/files/${stage}/download`);
  const headers = new Headers();

  for (const name of ["content-type", "content-disposition", "content-length", "last-modified", "etag"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
