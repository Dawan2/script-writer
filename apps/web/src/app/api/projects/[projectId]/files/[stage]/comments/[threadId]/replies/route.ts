import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string; stage: string; threadId: string }> };

export async function POST(request: Request, context: Params) {
  const { projectId, stage, threadId } = await context.params;
  return proxyJson(`/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/replies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
