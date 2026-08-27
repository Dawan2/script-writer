import { proxyJson } from "@/lib/server/backend";


export async function GET() {
  return proxyJson("/notifications?limit=30");
}
