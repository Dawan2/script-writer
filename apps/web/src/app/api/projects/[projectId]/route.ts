import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function PATCH(request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}

export async function DELETE(_request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}`, { method: "DELETE" });
}
