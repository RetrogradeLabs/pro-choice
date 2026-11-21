import type { NextConfig } from "next";

const DATA_TRACE_FILES = ["./data/snapshot.json", "./data/lifecycle.json"];
const VARY_ACCEPT_HEADERS = [{ key: "Vary", value: "Accept" }];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  compress: true,
  images: {
    formats: ["image/avif", "image/webp"],
  },
  turbopack: {
    root: import.meta.dirname,
  },
  outputFileTracingIncludes: {
    "/": DATA_TRACE_FILES,
    "/coding": DATA_TRACE_FILES,
    "/writing": DATA_TRACE_FILES,
    "/design": DATA_TRACE_FILES,
    "/research": DATA_TRACE_FILES,
    "/cyber": DATA_TRACE_FILES,
    "/harnesses": DATA_TRACE_FILES,
    "/docs": DATA_TRACE_FILES,
    "/about": DATA_TRACE_FILES,
    "/contact": DATA_TRACE_FILES,
    "/privacy": DATA_TRACE_FILES,
    "/api/snapshot": DATA_TRACE_FILES,
    "/api/v1/snapshot": DATA_TRACE_FILES,
    "/api/v1/domains/[domain]": DATA_TRACE_FILES,
    "/api/markdown": DATA_TRACE_FILES,
    "/api/markdown/[...slug]": DATA_TRACE_FILES,
    "/llms.txt": DATA_TRACE_FILES,
    "/llms-full.txt": DATA_TRACE_FILES,
    "/openapi.json": DATA_TRACE_FILES,
    "/sitemap.xml": DATA_TRACE_FILES,
  },
  async headers() {
    return [
      { source: "/", headers: VARY_ACCEPT_HEADERS },
      {
        source: "/:page(coding|writing|design|research|cyber|harnesses|docs|about|contact|privacy)",
        headers: VARY_ACCEPT_HEADERS,
      },
    ];
  },
  experimental: {
    inlineCss: true,
    optimizePackageImports: ["lucide-react", "@base-ui/react", "d3-scale", "motion/react"],
  },
};

export default nextConfig;
