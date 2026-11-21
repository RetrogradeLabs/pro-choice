import { ORG_URL, SITE_URL } from "@/lib/seo";

const SECURITY_TXT = [
  `Contact: ${ORG_URL}`,
  `Canonical: ${SITE_URL}/.well-known/security.txt`,
  "Preferred-Languages: en",
  "Expires: 2027-11-21T00:00:00.000Z",
  "",
].join("\n");

export function GET() {
  return new Response(SECURITY_TXT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
