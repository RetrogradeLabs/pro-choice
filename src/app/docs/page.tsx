import type { Metadata } from "next";
import { InfoPageShell } from "@/components/InfoPageShell";
import { BENCHMARKS } from "@/config/benchmarks";
import { loadCachedRelease } from "@/lib/release-cache";
import { formatUtcDate, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  title: "ProChoice API & Agent Documentation",
  description:
    "Public read-only JSON endpoints, OpenAPI 3.1 schema, Markdown content negotiation, versioning policy, and RFC 9457 error semantics for ProChoice.",
  alternates: {
    canonical: `${SITE_URL}/docs`,
    types: {
      "text/markdown": `${SITE_URL}/docs`,
      "application/openapi+json": `${SITE_URL}/openapi.json`,
    },
  },
};

export default async function DocsPage() {
  const { snapshot } = await loadCachedRelease();
  const updated = formatUtcDate(snapshot.generatedAt);

  return (
    <InfoPageShell
      title="ProChoice API & Agent Documentation"
      subtitle="Public, unauthenticated, read-only JSON and Markdown interfaces for ProChoice LLM and coding agent harness rankings."
      updatedDate={updated}
    >
      <section id="endpoints" className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">REST API v1 endpoints</h2>
        <p>
          All API routes are public, require no API key or OAuth token, and serve read-only
          benchmark data compiled daily from 13 live sources under CC BY 4.0.
        </p>
        <div className="overflow-x-auto border border-(--border) bg-(--surface)">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-(--border) bg-(--subtle) font-mono text-[11.5px] text-(--ink-muted)">
                <th className="px-4 py-2.5 font-medium">Endpoint</th>
                <th className="px-4 py-2.5 font-medium">Media type</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-(--border)">
                <td className="px-4 py-2.5 font-mono text-(--ink)">GET /api/v1/snapshot</td>
                <td className="px-4 py-2.5 font-mono text-(--ink-muted)">application/json</td>
                <td className="px-4 py-2.5">
                  Full snapshot across all 6 domains, 25 controlled harnesses, source health, and{" "}
                  {BENCHMARKS.length} lifecycle audits.
                </td>
              </tr>
              <tr className="border-b border-(--border)">
                <td className="px-4 py-2.5 font-mono text-(--ink)">
                  GET /api/v1/domains/{"{domain}"}
                </td>
                <td className="px-4 py-2.5 font-mono text-(--ink-muted)">application/json</td>
                <td className="px-4 py-2.5">
                  Headline picks and Pareto frontier for coding, writing, design, research, cyber,
                  or harnesses.
                </td>
              </tr>
              <tr className="border-b border-(--border)">
                <td className="px-4 py-2.5 font-mono text-(--ink)">GET /openapi.json</td>
                <td className="px-4 py-2.5 font-mono text-(--ink-muted)">
                  application/openapi+json
                </td>
                <td className="px-4 py-2.5">
                  OpenAPI 3.1.0 schema covering every response and RFC 9457 error payload.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-mono text-(--ink)">GET /.well-known/api-catalog</td>
                <td className="px-4 py-2.5 font-mono text-(--ink-muted)">
                  application/linkset+json
                </td>
                <td className="px-4 py-2.5">RFC 9727 machine-readable API discovery linkset.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="examples" className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Quickstart examples</h2>
        <pre className="overflow-x-auto border border-(--border) bg-(--surface) p-4 font-mono text-[12.5px] leading-relaxed text-(--ink)">
          {`# Fetch the Coding Pareto frontier as typed JSON
curl -sS https://prochoice.industries/api/v1/domains/coding

# Request clean Markdown directly on any leaderboard page
curl -sS -H "Accept: text/markdown" https://prochoice.industries/coding

# Read the concise agent directory or full Markdown compendium
curl -sS https://prochoice.industries/llms.txt
curl -sS https://prochoice.industries/llms-full.txt`}
        </pre>
      </section>

      <section id="markdown" className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Markdown content negotiation
        </h2>
        <p>
          Every public route supports HTTP content negotiation via{" "}
          <code className="font-mono text-[13px] text-(--ink)">Accept: text/markdown</code>.
          Negotiated responses return{" "}
          <code className="font-mono text-[13px] text-(--ink)">
            Content-Type: text/markdown; charset=utf-8
          </code>{" "}
          with <code className="font-mono text-[13px] text-(--ink)">Vary: Accept</code> and an
          approximate token count in{" "}
          <code className="font-mono text-[13px] text-(--ink)">X-Markdown-Tokens</code>. Direct
          static aliases are also available at{" "}
          <code className="font-mono text-[13px]">/coding.md</code> through{" "}
          <code className="font-mono text-[13px]">/harnesses.md</code>.
        </p>
      </section>

      <section id="versioning" className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">
          Versioning, deprecation, and rate limits
        </h2>
        <p>
          Stable REST endpoints are versioned in the URL path under{" "}
          <code className="font-mono text-[13px] text-(--ink)">/api/v1/</code>. Breaking response
          changes require a new major version path such as{" "}
          <code className="font-mono text-[13px] text-(--ink)">/api/v2/</code>, and any deprecated
          route announces retirement in advance through RFC 9745{" "}
          <code className="font-mono text-[13px]">Deprecation</code> and{" "}
          <code className="font-mono text-[13px]">Sunset</code> headers.
        </p>
        <p>
          Responses publish IETF <code className="font-mono text-[13px]">RateLimit-Policy</code> and{" "}
          <code className="font-mono text-[13px]">RateLimit</code> headers (120 requests per 60
          seconds per IP) plus strong <code className="font-mono text-[13px]">ETag</code> headers so
          clients can poll with <code className="font-mono text-[13px]">If-None-Match</code> for
          zero-byte 304 responses.
        </p>
      </section>

      <section id="errors" className="space-y-3">
        <h2 className="font-display text-[22px] font-normal text-(--ink)">Error model</h2>
        <p>
          Every API error returns RFC 9457{" "}
          <code className="font-mono text-[13px] text-(--ink)">application/problem+json</code> with{" "}
          <code className="font-mono text-[13px]">status</code>,{" "}
          <code className="font-mono text-[13px]">code</code>,{" "}
          <code className="font-mono text-[13px]">title</code>,{" "}
          <code className="font-mono text-[13px]">detail</code>, and a concrete{" "}
          <code className="font-mono text-[13px]">resolution</code> hint. Non-GET methods return
          HTTP 405 with an <code className="font-mono text-[13px]">Allow: GET, HEAD</code> header.
        </p>
      </section>
    </InfoPageShell>
  );
}
