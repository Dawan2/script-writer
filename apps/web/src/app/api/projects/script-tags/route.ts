import { proxyJson } from "@/lib/server/backend";

export async function GET() {
  return proxyJson("/projects/script-tags");
}
