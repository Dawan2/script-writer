import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string; stage: string; threadId: string; messageId: string }> };

export async function DELETE(_request: Request, context: Params) {
  const { projectId, stage, threadId, messageId } = await context.params;
  return proxyJson(
    `/projects/${projectId}/files/${encodeURIComponent(stage)}/comments/${threadId}/messages/${messageId}`,
    { method: "DELETE" }
  );
}
