import type { Metadata } from "next";
import "./globals.css";
import "./landing.css";

export const metadata: Metadata = {
  title: "出海剧作家｜你专属的海外主编",
  description: "帮你保住原剧爽点，完成跨文化改编与海外审稿，让中文短剧更贴近当地观众和发行要求。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
