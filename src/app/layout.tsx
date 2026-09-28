import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "MaxTV — Live Sports & Free IPTV",
  description:
    "Pluto TV style streaming: live sports events, 24/7 sports channels and 11,000+ free IPTV channels aggregated from IPTV-Scraper-Zilla. Sports first, everything else in one place.",
  keywords: ["IPTV", "live sports", "streaming", "free TV", "sports", "maxtv"],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/maxtv-icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/maxtv-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0c0f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${rubik.variable} font-sans antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
