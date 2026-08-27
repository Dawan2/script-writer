import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

export function middleware(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/workspace")
    || request.nextUrl.pathname.startsWith("/preferences")
    || request.nextUrl.pathname.startsWith("/admin")
    || request.nextUrl.pathname.startsWith("/batch-tasks")
  ) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
      const loginUrl = new URL("/", request.url);
      loginUrl.searchParams.set("login", "1");
      return NextResponse.redirect(loginUrl);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/workspace/:path*", "/preferences/:path*", "/admin/:path*", "/batch-tasks/:path*"]
};
