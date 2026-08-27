import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/files`);
}
