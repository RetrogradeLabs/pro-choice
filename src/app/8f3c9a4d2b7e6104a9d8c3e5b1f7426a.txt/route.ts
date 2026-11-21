const INDEXNOW_KEY = "8f3c9a4d2b7e6104a9d8c3e5b1f7426a";

export function GET() {
  return new Response(INDEXNOW_KEY, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
    },
  });
}
