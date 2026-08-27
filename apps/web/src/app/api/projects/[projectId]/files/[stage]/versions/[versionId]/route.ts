import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string; stage: string; versionId: string }> };

export async function GET(_request: Request, context: Params) {
  const { projectId, stage, versionId } = await context.params;
  return proxyJson(`/projects/${projectId}/files/${encodeURIComponent(stage)}/versions/${versionId}`);
}
