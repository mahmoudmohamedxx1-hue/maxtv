import type { Metadata, Viewport } from "next";
import { Rubik, Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { BootClient } from "@/components/app/BootClient";

const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

/** Arabic UI font — Rubik has no Arabic glyphs. Swapped in by the
 *  `html[lang="ar"] body` rule in globals.css when the locale is Arabic. */
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "MaxTV — Live Sports & Free IPTV",
  description:
    "Pluto TV style streaming: live sports events, 24/7 sports channels and 11,000+ free IPTV channels aggregated from IPTV-Scraper-Zilla. Sports first, everything else in one place.",
  keywords: ["IPTV", "live sports", "streaming", "free TV", "sports", "maxtv"],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/maxtv-icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/maxtv-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MaxTV",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0c0f",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** Pre-hydration locale boot — reads the persisted locale and flips
 *  <html lang/dir> before first paint so Arabic users never see an LTR flash.
 *  (zustand persist stores { state: { locale } } as JSON.) */
const LOCALE_BOOT = `try{var s=JSON.parse(localStorage.getItem('maxtv-locale')||'{}');if(s&&s.state&&s.state.locale==='ar'){document.documentElement.lang='ar';document.documentElement.dir='rtl';}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT }} />
      </head>
      <body className={`${rubik.variable} ${cairo.variable} font-sans antialiased`}>
        <BootClient />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
