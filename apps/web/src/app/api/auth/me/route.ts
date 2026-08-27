import { proxyJson } from "@/lib/server/backend";

export async function GET() {
  return proxyJson("/auth/me");
}
