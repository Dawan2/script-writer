import { cookies, headers as requestHeaders } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

export const API_BASE = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

export async function sessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

export async function backendFetch(path: string, init: RequestInit = {}) {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  const incomingHeaders = await requestHeaders();
  const internalSyncToken = incomingHeaders.get("x-script-sync-internal-token");
  if (!headers.has("x-audit-source")) {
    headers.set("x-audit-source", "web");
  }
  if (internalSyncToken && !headers.has("x-script-sync-internal-token")) {
    headers.set("x-script-sync-internal-token", internalSyncToken);
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store"
  });
}

export async function proxyJson(path: string, init: RequestInit = {}) {
  const response = await backendFetch(path, init);
  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  });
}
