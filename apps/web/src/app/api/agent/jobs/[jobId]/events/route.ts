import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: Params) {
  const { jobId } = await context.params;
  const url = new URL(request.url);
  const afterId = url.searchParams.get("after_id");
  return proxyJson(`/agent/jobs/${jobId}/events${afterId ? `?after_id=${encodeURIComponent(afterId)}` : ""}`);
}
