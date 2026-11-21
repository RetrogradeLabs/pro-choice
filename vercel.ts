import type { VercelConfig } from "@vercel/config/v1";
import { routes } from "@vercel/config/v1";

const ACCEPT_MARKDOWN_REGEX = ".*[Tt][Ee][Xx][Tt]/[Mm][Aa][Rr][Kk][Dd][Oo][Ww][Nn].*";
const DISCOVERY_LINK_HEADER =
  '</llms.txt>; rel="describedby"; type="text/markdown", </.well-known/api-catalog>; rel="api-catalog", </sitemap.xml>; rel="sitemap"; type="application/xml"';

export const config: VercelConfig = {
  framework: "nextjs",
  bunVersion: "1.4.x",
  fluid: true,
  cleanUrls: true,
  trailingSlash: false,
  regions: ["iad1"],
  installCommand: "bash scripts/vercel-install.sh",
  buildCommand: "$HOME/.bun/bin/bun run build",
  redirects: [
    {
      source: "/:path*",
      has: [{ type: "host", value: "www.prochoice.industries" }],
      destination: "https://prochoice.industries/:path*",
      permanent: true,
    },
    {
      source: "/design_code",
      destination: "/design",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "coding" }],
      destination: "/coding",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "writing" }],
      destination: "/writing",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "design_code" }],
      destination: "/design",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "design" }],
      destination: "/design",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "research" }],
      destination: "/research",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "cyber" }],
      destination: "/cyber",
      permanent: true,
    },
    {
      source: "/",
      has: [{ type: "query", key: "d", value: "harnesses" }],
      destination: "/harnesses",
      permanent: true,
    },
  ],
  rewrites: [
    {
      source: "/index.md",
      destination: "/api/markdown",
    },
    {
      source: "/:domain(coding|writing|design|research|cyber|harnesses).md",
      destination: "/api/markdown?d=:domain",
    },
    {
      source: "/",
      has: [{ type: "header", key: "accept", value: ACCEPT_MARKDOWN_REGEX }],
      destination: "/api/markdown",
    },
    {
      source: "/:domain(coding|writing|design|research|cyber|harnesses)",
      has: [{ type: "header", key: "accept", value: ACCEPT_MARKDOWN_REGEX }],
      destination: "/api/markdown?d=:domain",
    },
  ],
  headers: [
    {
      source: "/(.*)",
      headers: [
        {
          key: "Content-Security-Policy",
          value:
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
        },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "Origin-Agent-Cluster", value: "?1" },
        { key: "X-DNS-Prefetch-Control", value: "on" },
        {
          key: "Permissions-Policy",
          value:
            "camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=(), interest-cohort=()",
        },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ],
    },
    routes.cacheControl("/_next/static/(.*)", {
      public: true,
      maxAge: "1 year",
      immutable: true,
    }),
    {
      source: "/(coding|writing|design|research|cyber|harnesses)?",
      headers: [
        { key: "Link", value: DISCOVERY_LINK_HEADER },
        { key: "Vary", value: "Accept" },
      ],
    },
    {
      source:
        "/(opengraph-image|apple-icon|icon\\.svg|manifest\\.webmanifest|(?:coding|writing|design|research|cyber|harnesses)/opengraph-image)",
      headers: [
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        {
          key: "Cache-Control",
          value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        },
      ],
    },
    {
      source:
        "/(api/.*|llms\\.txt|llms-full\\.txt|openapi\\.json|sitemap\\.xml|robots\\.txt|\\.well-known/.*|(?:index|coding|writing|design|research|cyber|harnesses)\\.md)",
      headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
    },
  ],
};
