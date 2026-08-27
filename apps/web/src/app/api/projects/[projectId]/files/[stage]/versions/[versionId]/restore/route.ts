import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string; stage: string; versionId: string }> };

export async function POST(request: Request, context: Params) {
  const { projectId, stage, versionId } = await context.params;
  return proxyJson(`/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
