import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { backendFetch } from "@/lib/server/backend";

export async function POST(request: Request) {
  const response = await backendFetch("/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return NextResponse.json(payload, { status: response.status });
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, payload.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
  return NextResponse.json({ user: payload.user });
}
