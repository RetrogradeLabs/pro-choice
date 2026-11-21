import { type NextRequest, NextResponse } from "next/server";

const KNOWN_MARKDOWN_SLUGS = new Set<string>([
  "coding",
  "writing",
  "design",
  "research",
  "cyber",
  "harnesses",
  "docs",
  "about",
  "contact",
  "privacy",
]);

const DISCOVERY_LINK_HEADER =
  '</llms.txt>; rel="describedby"; type="text/markdown", </.well-known/api-catalog>; rel="api-catalog", </sitemap.xml>; rel="sitemap"; type="application/xml"';

function prefersMarkdown(acceptHeader: string | null): boolean {
  if (!acceptHeader) return false;
  return /\btext\/markdown\b/i.test(acceptHeader);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (prefersMarkdown(request.headers.get("accept"))) {
    const cleaned = pathname.replace(/^\/+|\/+$/g, "");
    let destPath: string;
    if (cleaned === "") {
      destPath = "/api/markdown/home";
    } else if (KNOWN_MARKDOWN_SLUGS.has(cleaned)) {
      destPath = `/api/markdown/${cleaned}`;
    } else {
      destPath = `/api/markdown/not-found/${cleaned}`;
    }
    const destination = new URL(request.url);
    destination.pathname = destPath;
    return NextResponse.rewrite(destination);
  }

  const response = NextResponse.next();
  response.headers.append("Link", DISCOVERY_LINK_HEADER);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|\\.well-known/|icon\\.svg|apple-icon|opengraph-image|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|llms\\.txt|llms-full\\.txt|openapi\\.json|8f3c9a4d2b7e6104a9d8c3e5b1f7426a\\.txt|.*\\.md$|.*/opengraph-image$).*)",
  ],
};
