import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Params) {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  const stage = url.searchParams.get("stage");
  return proxyJson(`/projects/${projectId}/agent/history${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`);
}
