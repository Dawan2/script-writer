import { proxyJson } from "@/lib/server/backend";


export async function POST(request: Request) {
  return proxyJson("/me/writer-preferences/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
