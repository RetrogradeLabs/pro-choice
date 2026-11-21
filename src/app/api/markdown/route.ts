import { buildMarkdownResponse } from "@/lib/markdown-response";

export async function GET(request: Request) {
  const reqUrl = new URL(request.url);
  const rawDomain = reqUrl.searchParams.get("d");
  const ifNoneMatch = request.headers.get("if-none-match");
  return buildMarkdownResponse(rawDomain, null, ifNoneMatch, reqUrl.searchParams.get("m"));
}
