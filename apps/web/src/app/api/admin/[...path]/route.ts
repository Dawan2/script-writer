import { proxyJson } from "@/lib/server/backend";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const url = new URL(request.url);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  return proxyJson(`/admin/${path.map(encodeURIComponent).join("/")}${url.search}`, {
    method: request.method,
    headers: body?.byteLength ? { "content-type": request.headers.get("content-type") ?? "application/json" } : undefined,
    body
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
