import type { Metadata, Viewport } from "next";
import "./globals.css";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://lnkiai.github.io"),
  title: "M3E Canvas",
  description:
    "Sketch Material 3 Expressive screens in the browser and turn them into vibe-coding prompts. / Material 3 Expressive の画面をブラウザで組み立てて、そのままプロンプトに。",
  openGraph: {
    title: "M3E Canvas",
    description: "Design Material 3 Expressive screens, link them, preview them, and copy a prompt for your AI coding tool.",
    images: [`${BASE}/og.png`],
    type: "website",
  },
  twitter: { card: "summary_large_image", images: [`${BASE}/og.png`] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <head>
        {/* Fonts are self-hosted in public/fonts (Google Fonts CDN is unreachable on some networks). */}
        <link rel="stylesheet" href={`${BASE}/fonts/roboto.css`} />
        <link rel="stylesheet" href={`${BASE}/fonts/material-symbols.css`} />
      </head>
      <body style={{ fontFamily: "Roboto, system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
