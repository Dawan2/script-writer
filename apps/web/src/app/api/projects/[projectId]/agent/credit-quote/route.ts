import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Params) {
  const { projectId } = await context.params;
  const url = new URL(request.url);
  return proxyJson(`/projects/${projectId}/agent/credit-quote${url.search}`);
}
