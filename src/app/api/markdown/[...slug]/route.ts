import { buildMarkdownResponse } from "@/lib/markdown-response";

export async function GET(request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const ifNoneMatch = request.headers.get("if-none-match");
  const { slug } = await context.params;

  if (slug[0] === "not-found") {
    const rest = slug.slice(1).join("/");
    return buildMarkdownResponse(null, `/${rest}`, ifNoneMatch);
  }

  return buildMarkdownResponse(
    slug.join("/"),
    null,
    ifNoneMatch,
    new URL(request.url).searchParams.get("m"),
  );
}
