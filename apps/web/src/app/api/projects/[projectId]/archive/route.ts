import { proxyJson } from "@/lib/server/backend";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
