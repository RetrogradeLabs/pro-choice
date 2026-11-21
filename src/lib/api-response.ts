import { SITE_URL } from "@/lib/seo";

export const API_RATE_LIMIT_POLICY = "120;w=60";
export const API_RATE_LIMIT = "limit=120, remaining=119, reset=60";
export const API_LINK_HEADER =
  '</openapi.json>; rel="service-desc"; type="application/openapi+json", </docs>; rel="service-doc"; type="text/html", </llms.txt>; rel="describedby"; type="text/markdown"';

export const API_COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "API-Version": "1",
  "RateLimit-Policy": API_RATE_LIMIT_POLICY,
  RateLimit: API_RATE_LIMIT,
  Link: API_LINK_HEADER,
};

export interface ProblemDetailsInput {
  status: number;
  code: string;
  title: string;
  detail: string;
  resolution: string;
  instance?: string;
  extraHeaders?: Record<string, string>;
}

export function problemJson(input: ProblemDetailsInput): Response {
  const payload = {
    type: `${SITE_URL}/docs#errors`,
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    resolution: input.resolution,
    ...(input.instance ? { instance: input.instance } : {}),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: input.status,
    headers: {
      "Content-Type": "application/problem+json; charset=utf-8",
      "Cache-Control": "no-store",
      ...API_COMMON_HEADERS,
      ...input.extraHeaders,
    },
  });
}

export function methodNotAllowedProblem(instance: string): Response {
  return problemJson({
    status: 405,
    code: "method_not_allowed",
    title: "Method Not Allowed",
    detail: "This ProChoice endpoint is public and read-only. Only GET and HEAD are supported.",
    resolution: "Retry the request using HTTP GET.",
    instance,
    extraHeaders: { Allow: "GET, HEAD" },
  });
}
