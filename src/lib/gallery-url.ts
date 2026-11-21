import { HARNESS_BY_ID } from "@/config/harnesses";
import { ALL_PROVIDER_IDS, WESTERN_PROVIDER_IDS } from "@/config/providers";
import type { DomainId, HarnessId, ProviderId } from "@/lib/schema";
import { domainToPathname, parseDomainSlug } from "@/lib/seo";

const VALID_PROVIDERS = new Set<string>(ALL_PROVIDER_IDS);

export type GalleryView = "home" | DomainId;
export type HarnessViewTab = "controlled" | "stacks";

export interface GalleryUrlState {
  view: GalleryView;
  providers: ProviderId[];
  harness: HarnessId | "all";
  harnessTab: HarnessViewTab;
  harnessModel: string;
  showPruned: boolean;
}

export function isDefaultWesternSelection(providers: readonly ProviderId[]): boolean {
  return (
    providers.length === WESTERN_PROVIDER_IDS.length &&
    WESTERN_PROVIDER_IDS.every((p, idx) => providers[idx] === p)
  );
}

export function defaultGalleryState(view: GalleryView = "home"): GalleryUrlState {
  return {
    view,
    providers: [...WESTERN_PROVIDER_IDS],
    harness: "all",
    harnessTab: "controlled",
    harnessModel: "_all",
    showPruned: false,
  };
}

export function parseGalleryUrl(pathname: string, search: string): GalleryUrlState {
  const params = new URLSearchParams(search);
  const pathSeg = pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  const pathDomain = parseDomainSlug(pathSeg);
  const queryDomain = parseDomainSlug(params.get("d"));
  const view: GalleryView = pathDomain ?? queryDomain ?? "home";

  const rawProviders = (params.get("p") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ProviderId => VALID_PROVIDERS.has(s));

  const uniqueProviders = [...new Set(rawProviders)];
  const providers: ProviderId[] =
    uniqueProviders.length > 0 ? uniqueProviders : [...WESTERN_PROVIDER_IDS];

  const rawTab = params.get("tab");
  const harnessTab: HarnessViewTab = rawTab === "stacks" ? "stacks" : "controlled";
  const rawModel = params.get("m")?.trim();
  const harnessModel = rawModel && rawModel.length > 0 ? rawModel : "_all";

  const rawHarness = params.get("h");
  const harnessMeta =
    rawHarness && Object.hasOwn(HARNESS_BY_ID, rawHarness)
      ? HARNESS_BY_ID[rawHarness as HarnessId]
      : null;
  const harness: HarnessId | "all" =
    view === "harnesses" &&
    harnessTab === "stacks" &&
    harnessMeta &&
    harnessMeta.regime === "native" &&
    harnessMeta.userSelectable
      ? harnessMeta.id
      : "all";

  const showPruned = params.get("x") === "1";

  return { view, providers, harness, harnessTab, harnessModel, showPruned };
}

export function parseGalleryQueryString(search: string): GalleryUrlState {
  return parseGalleryUrl("/", search);
}

export function serializeGalleryUrl(state: GalleryUrlState): string {
  if (state.view === "home") return "/";
  const basePath = domainToPathname(state.view);
  const params = new URLSearchParams();
  if (state.view === "harnesses") {
    if (state.harnessTab === "stacks") {
      params.set("tab", "stacks");
      if (!isDefaultWesternSelection(state.providers)) {
        params.set("p", state.providers.join(","));
      }
      if (state.harness !== "all") params.set("h", state.harness);
    } else {
      if (state.harnessModel !== "_all") params.set("m", state.harnessModel);
      if (!isDefaultWesternSelection(state.providers)) {
        params.set("p", state.providers.join(","));
      }
    }
  } else if (!isDefaultWesternSelection(state.providers)) {
    params.set("p", state.providers.join(","));
  }
  if (state.showPruned) params.set("x", "1");
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function serializeGalleryQueryString(state: GalleryUrlState): string {
  return serializeGalleryUrl(state);
}
