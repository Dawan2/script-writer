import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Params) {
  const { projectId } = await context.params;
  return proxyJson(`/projects/${projectId}/reinitialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
