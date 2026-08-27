import { proxyJson } from "@/lib/server/backend";

type Params = { params: Promise<{ path: string[] }> };

function backendPath(request: Request, path: string[]) {
  const url = new URL(request.url);
  return `/batch-tasks/${path.map(encodeURIComponent).join("/")}${url.search}`;
}

export async function GET(request: Request, context: Params) {
  const { path } = await context.params;
  return proxyJson(backendPath(request, path));
}

export async function POST(request: Request, context: Params) {
  const { path } = await context.params;
  const contentType = request.headers.get("content-type");
  const body = contentType ? await request.text() : undefined;
  return proxyJson(backendPath(request, path), {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body
  });
}

export async function DELETE(request: Request, context: Params) {
  const { path } = await context.params;
  return proxyJson(backendPath(request, path), { method: "DELETE" });
}
