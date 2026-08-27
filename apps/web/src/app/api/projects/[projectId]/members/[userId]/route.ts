import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string; userId: string }> };

export async function PUT(request: Request, context: Params) {
  const { projectId, userId } = await context.params;
  return proxyJson(`/projects/${projectId}/members/${userId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}

export async function DELETE(_request: Request, context: Params) {
  const { projectId, userId } = await context.params;
  return proxyJson(`/projects/${projectId}/members/${userId}`, { method: "DELETE" });
}
