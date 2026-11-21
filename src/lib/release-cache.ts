import { cacheLife } from "next/cache";
import { loadRelease, type PublishedRelease } from "@/lib/data";

export async function loadCachedRelease(): Promise<PublishedRelease> {
  "use cache";
  cacheLife("max");
  return loadRelease();
}
