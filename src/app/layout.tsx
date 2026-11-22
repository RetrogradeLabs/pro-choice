import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";
import { ORG_NAME, ORG_URL, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/seo";
import "./globals.css";

const newsreader = Newsreader({
  weight: ["400", "500"],
  style: ["normal"],
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: ORG_NAME, url: ORG_URL }],
  creator: ORG_NAME,
  publisher: ORG_NAME,
  category: "technology",
  keywords: [
    "LLM leaderboard",
    "AI model rankings",
    "private LLM benchmarks",
    "contamination-free AI benchmarks",
    "frontier LLM benchmarks",
    "coding agent harness benchmark",
    "LLM cost comparison",
    "Pareto frontier AI models",
    "ProChoice",
    "Retrograde Labs",
  ],
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  other: {
    "is-agentic-site-type": "content",
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: "@retrogradelabs",
    creator: "@retrogradelabs",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf8" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1816" },
  ],
};

// Resolve saved override or OS system theme before first paint so light/dark never flashes
const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem("prochoice-theme");var t=s==="dark"||s==="light"?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${newsreader.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline theme initializer before first paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="relative min-h-screen bg-(--bg) font-sans text-(--ink) antialiased selection:bg-(--selection-bg) selection:text-(--selection-fg)">
        <div className="isolate">{children}</div>
      </body>
    </html>
  );
}
