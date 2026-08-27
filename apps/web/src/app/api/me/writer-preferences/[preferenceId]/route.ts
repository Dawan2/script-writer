import { proxyJson } from "@/lib/server/backend";


type Params = { params: Promise<{ preferenceId: string }> };


export async function PATCH(request: Request, context: Params) {
  const { preferenceId } = await context.params;
  return proxyJson(`/me/writer-preferences/${preferenceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}


export async function DELETE(_request: Request, context: Params) {
  const { preferenceId } = await context.params;
  return proxyJson(`/me/writer-preferences/${preferenceId}`, { method: "DELETE" });
}
