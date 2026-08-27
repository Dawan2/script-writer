import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ projectId: string; sourceKey: string }> };

const ORIGINAL_EXPORTS = {
  // The compatibility delivery API derives rewrite trials from the completed
  // full script while preserving standalone trials for novel/replicate tasks.
  trial_script: "/files/trial_generate/download?format=delivery-docx",
  full_script: "/files/full_generate/download?format=delivery-docx",
  review_report: "/files/foreign_review/download"
} as const;

const TRANSLATED_EXPORTS = {
  trial_script: "/files/dialogue_translate/download?format=delivery-docx&scope=trial",
  full_script: "/files/dialogue_translate/download?format=delivery-docx&scope=full"
} as const;

export const runtime = "nodejs";
export const maxDuration = 180;

const LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN = "orca-script-workbench-local-script-sync";

function trustedRequest(request: Request) {
  const expected = process.env.SCRIPT_SYNC_INTERNAL_TOKEN?.trim()
    || (process.env.SCRIPT_SYNC_LOCAL_MODE === "1" ? LOCAL_SCRIPT_SYNC_INTERNAL_TOKEN : "");
  const supplied = request.headers.get("x-script-sync-internal-token");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function GET(request: Request, context: Params) {
  if (!trustedRequest(request)) {
    return NextResponse.json({ detail: "未找到资源" }, { status: 404 });
  }
  const { projectId, sourceKey } = await context.params;
  const useDialogueTranslation = new URL(request.url).searchParams.get("use_dialogue_translation") === "1";
  const exportPath = useDialogueTranslation && sourceKey in TRANSLATED_EXPORTS
    ? TRANSLATED_EXPORTS[sourceKey as keyof typeof TRANSLATED_EXPORTS]
    : ORIGINAL_EXPORTS[sourceKey as keyof typeof ORIGINAL_EXPORTS];
  if (!exportPath || !/^\d+$/.test(projectId)) {
    return NextResponse.json({ detail: "未找到资源" }, { status: 404 });
  }

  const origin = process.env.INTERNAL_WEB_BASE_URL ?? new URL(request.url).origin;
  let response: Response;
  try {
    response = await fetch(`${origin}/api/projects/${projectId}${exportPath}`, {
      headers: { "x-script-sync-internal-token": request.headers.get("x-script-sync-internal-token") ?? "" },
      cache: "no-store"
    });
  } catch {
    return NextResponse.json({ detail: "附件导出服务暂时不可用，请稍后重试。" }, { status: 503 });
  }
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "content-length"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
