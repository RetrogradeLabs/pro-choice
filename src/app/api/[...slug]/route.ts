import { problemJson } from "@/lib/api-response";

async function handleApiNotFound(
  _request: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await context.params;
  const instance = `/api/${slug.join("/")}`;
  return problemJson({
    status: 404,
    code: "endpoint_not_found",
    title: "API Endpoint Not Found",
    detail: `No ProChoice API endpoint exists at ${instance}.`,
    resolution:
      "Use GET /api/v1/snapshot or GET /api/v1/domains/{domain}. See https://prochoice.industries/openapi.json.",
    instance,
  });
}

export const GET = handleApiNotFound;
export const POST = handleApiNotFound;
export const PUT = handleApiNotFound;
export const PATCH = handleApiNotFound;
export const DELETE = handleApiNotFound;
