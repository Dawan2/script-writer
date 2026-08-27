import { proxyJson } from "@/lib/server/backend";


export async function POST() {
  return proxyJson("/notifications/read", { method: "POST" });
}
