import { backendFetch } from "@/lib/server/backend";

const ZDEBUG_PORT_START = 4301;
const ZDEBUG_PORT_END = 4400;

type RouteParams = {
  params: Promise<{ port: string; path?: string[] }>;
};

function jsonError(status: number, error: string) {
  return Response.json({ success: false, error }, { status });
}

async function requireDebugPermission() {
  const response = await backendFetch("/auth/me");
  if (!response.ok) {
    return jsonError(response.status, "请先登录后查看调试日志");
  }

  const payload = await response.json() as { user?: { permissions?: string[] } };
  return payload.user?.permissions?.includes("admin:jobs")
    ? null
    : jsonError(403, "你没有查看调试日志的权限");
}

async function proxyZDebug(request: Request, context: RouteParams) {
  const { port: rawPort, path = [] } = await context.params;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < ZDEBUG_PORT_START || port > ZDEBUG_PORT_END) {
    return jsonError(404, "调试日志服务不存在");
  }

  const authError = await requireDebugPermission();
  if (authError) return authError;

  const targetPath = path.map(encodeURIComponent).join("/");
  const targetUrl = new URL(`http://127.0.0.1:${port}/${targetPath}`);
  targetUrl.search = new URL(request.url).search;

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
    headers.set("cache-control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  } catch {
    return jsonError(502, "调试日志服务暂时不可用，请关闭后重新打开");
  }
}

export const GET = proxyZDebug;
export const HEAD = proxyZDebug;
