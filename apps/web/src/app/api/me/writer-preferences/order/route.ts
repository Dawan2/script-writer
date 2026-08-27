import { proxyJson } from "@/lib/server/backend";


export async function PUT(request: Request) {
  return proxyJson("/me/writer-preferences/order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
}
