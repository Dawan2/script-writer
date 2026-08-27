import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/agent/jobs/active`);
}

export async function POST(request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/agent/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
