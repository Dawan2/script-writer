import { proxyJson } from "@/lib/server/backend";

export async function POST(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/reopen`, { method: "POST" });
}
