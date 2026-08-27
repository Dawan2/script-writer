import { proxyJson } from "@/lib/server/backend";

type RouteContext = { params: Promise<{ notificationId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { notificationId } = await context.params;
  return proxyJson(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" });
}
