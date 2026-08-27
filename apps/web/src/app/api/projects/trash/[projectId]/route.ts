import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function DELETE(_request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/trash/${projectId}`, { method: "DELETE" });
}
