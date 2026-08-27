import { proxyJson } from "@/lib/server/backend";


export async function GET() {
  return proxyJson("/me/writer-preferences/export");
}
