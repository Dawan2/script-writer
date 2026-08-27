import { proxyJson } from "@/lib/server/backend";

export async function GET() {
  return proxyJson("/credits/me");
}
