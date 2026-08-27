import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/members`);
}

export async function PUT(request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/members`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
