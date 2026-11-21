"use client";

import { Moon, Sun } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import {
  type MouseEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { DOMAIN_BY_ID, DOMAINS } from "@/config/benchmarks";
import { ALL_PROVIDER_IDS, WESTERN_PROVIDER_IDS } from "@/config/providers";
import { compareIsoInstants } from "@/lib/format";
import {
  type GalleryUrlState,
  type HarnessViewTab,
  parseGalleryUrl,
  serializeGalleryUrl,
} from "@/lib/gallery-url";
import { buildHomeSummaries, type HomeDomainSummary } from "@/lib/home-summaries";
import type {
  DomainId,
  DomainSnapshot,
  EvaluatedConfig,
  HarnessId,
  HarnessLeaderboardSnapshot,
  LifecycleReport,
  ProChoiceSnapshot,
  ProviderFrontier,
  ProviderId,
  SourceHealth,
} from "@/lib/schema";
import { domainToPathname, ORG_NAME, ORG_URL, REPO_URL, SITE_NAME, SITE_TITLE } from "@/lib/seo";
import { ControlledBoardPicker } from "./ControlledBoardPicker";
import { EpochMonographDrawer } from "./EpochMonographDrawer";
import { FrontierCatalogue } from "./FrontierCatalogue";
import { HarnessesControlledView } from "./HarnessesView";
import { HomeView } from "./HomeView";
import { ObservedBenchmarkTables } from "./ObservedBenchmarkTables";
import { ParetoPlate } from "./ParetoPlate";
import { ProviderPicker } from "./ProviderPicker";
import { PrunedCatalogue } from "./PrunedCatalogue";
import { VerdictPlacards } from "./VerdictPlacards";

interface SnapshotMeta {
  schemaVersion: number;
  generatedAt: string;
  snapshotHash: string;
  sources: readonly SourceHealth[];
}

interface ProChoiceGalleryProps {
  snapshotMeta: SnapshotMeta;
  initialDomain: DomainSnapshot | null;
  harnessLeaderboard: HarnessLeaderboardSnapshot | null;
  homeSummaries: readonly HomeDomainSummary[];
  lifecycle: LifecycleReport | null;
  initialState: GalleryUrlState;
  initialUrl: string;
}

function isModifiedClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

const URL_CHANGE_EVENT = "prochoice-url-change";
const THEME_CHANGE_EVENT = "prochoice-theme-change";
const VIEW_EASE = [0.22, 1, 0.36, 1] as const;
const TAB_SPRING = { type: "spring", stiffness: 460, damping: 36 } as const;

function subscribeTheme(onStoreChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== "prochoice-theme") return;
    if (e.newValue === "dark" || e.newValue === "light") {
      document.documentElement.setAttribute("data-theme", e.newValue);
    } else {
      const sys = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", sys);
    }
    onStoreChange();
  };
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onMedia = (ev: MediaQueryListEvent) => {
    try {
      const saved = localStorage.getItem("prochoice-theme");
      if (saved !== "dark" && saved !== "light") {
        document.documentElement.setAttribute("data-theme", ev.matches ? "dark" : "light");
      }
    } catch {
      document.documentElement.setAttribute("data-theme", ev.matches ? "dark" : "light");
    }
    onStoreChange();
  };
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  mq?.addEventListener("change", onMedia);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
    mq?.removeEventListener("change", onMedia);
  };
}

function getThemeSnapshot(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function getThemeServerSnapshot(): boolean {
  return false;
}

function subscribeDesktopViewport(onStoreChange: () => void): () => void {
  const mq = window.matchMedia?.("(min-width: 1024px)");
  mq?.addEventListener("change", onStoreChange);
  return () => mq?.removeEventListener("change", onStoreChange);
}

function getDesktopViewportSnapshot(): boolean {
  return window.matchMedia?.("(min-width: 1024px)").matches ?? true;
}

function getDesktopViewportServerSnapshot(): boolean {
  return true;
}

function subscribeUrlHref(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener(URL_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener(URL_CHANGE_EVENT, onStoreChange);
  };
}

function getUrlHrefSnapshot(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function parseHrefToState(href: string): GalleryUrlState {
  const qIdx = href.indexOf("?");
  const pathname = qIdx === -1 ? href : href.slice(0, qIdx);
  const search = qIdx === -1 ? "" : href.slice(qIdx);
  return parseGalleryUrl(pathname, search);
}

function pushUrlState(next: GalleryUrlState, keepHash = false, pushHistory = false): void {
  const targetPath = serializeGalleryUrl(next);
  const hash = keepHash ? window.location.hash : "";
  const desired = `${targetPath}${hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== desired) {
    if (pushHistory) window.history.pushState(null, "", desired);
    else window.history.replaceState(null, "", desired);
  }
  window.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

function syncConfigHash(configId: string | null): void {
  const nextHash = configId ? `#config-${encodeURIComponent(configId)}` : "";
  const target = `${window.location.pathname}${window.location.search}${nextHash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== target) {
    window.history.replaceState(null, "", target);
  }
}

function formatUtcDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function getViewNavIndex(view: GalleryUrlState["view"]): number {
  if (view === "home") return 0;
  const idx = DOMAINS.findIndex((d) => d.id === view);
  return idx === -1 ? 0 : idx + 1;
}

function BrandMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-(--ink) transition-transform duration-200 group-hover:scale-[1.04]"
    >
      <rect
        x="0.75"
        y="0.75"
        width="22.5"
        height="22.5"
        rx="6"
        fill="var(--surface)"
        stroke="var(--border-strong)"
        strokeWidth="1.2"
      />
      <g transform="translate(2.65 4.15) scale(0.7)">
        <path
          d="M10.5 13.1L5.2 7.8L7.4 5.6L12 10.2L10.5 13.1Z"
          fill="currentColor"
          fillOpacity="0.28"
        />
        <path
          d="M10.4 20.5V11.8L16.3 5.9H12.4V3.2H20.8V11.6H18.1V7.7L13.2 12.6V20.5H10.4Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export function ProChoiceGallery({
  snapshotMeta,
  initialDomain,
  harnessLeaderboard,
  homeSummaries,
  lifecycle,
  initialState,
  initialUrl,
}: ProChoiceGalleryProps) {
  const prefersReducedMotion = useReducedMotion();
  const isDark = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const isDesktopViewport = useSyncExternalStore(
    subscribeDesktopViewport,
    getDesktopViewportSnapshot,
    getDesktopViewportServerSnapshot,
  );
  const urlHref = useSyncExternalStore(subscribeUrlHref, getUrlHrefSnapshot, () => initialUrl);
  const urlState = urlHref === initialUrl ? initialState : parseHrefToState(urlHref);

  // Track nav direction via event handlers (zero render-time setState) so desktop transitions vertically and mobile horizontally
  const [navMotion, setNavMotion] = useState<{
    viewDir: -1 | 0 | 1;
    tabDx: number;
  }>({
    viewDir: 0,
    tabDx: 0,
  });
  const [harnessSliceDx, setHarnessSliceDx] = useState(0);

  const [release, setRelease] = useState<{
    meta: SnapshotMeta;
    domains: Partial<Record<DomainId, DomainSnapshot>>;
    harnessLeaderboard: HarnessLeaderboardSnapshot | null;
    lifecycle: LifecycleReport | null;
    hydratedFull: boolean;
  }>(() => ({
    meta: snapshotMeta,
    domains: initialDomain ? { [initialDomain.domainId]: initialDomain } : {},
    harnessLeaderboard,
    lifecycle,
    hydratedFull: false,
  }));
  const [domainFetchError, setDomainFetchError] = useState(false);
  const snapshotPromiseRef = useRef<Promise<{
    snapshot: ProChoiceSnapshot;
    lifecycle: LifecycleReport;
  } | null> | null>(null);

  const [expandedConfigIds, setExpandedConfigIds] = useState<readonly string[]>([]);
  const [prunedSectionOpen, setPrunedSectionOpen] = useState(false);
  const [expandedPrunedIds, setExpandedPrunedIds] = useState<readonly string[]>([]);
  const selectedConfigId = expandedConfigIds[expandedConfigIds.length - 1] ?? null;
  const hasSyncedConfigHashRef = useRef(false);
  const [hoveredConfigId, setHoveredConfigId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [requestedObservations, setRequestedObservations] = useState(false);
  const [sliceVisit, setSliceVisit] = useState(0);

  const activeMeta = release.meta;
  const activeLifecycle = release.lifecycle;

  const isHome = urlState.view === "home";
  const activeDomainId: DomainId =
    urlState.view === "home" ? (initialDomain?.domainId ?? "coding") : urlState.view;
  const domain = release.domains[activeDomainId] ?? null;
  const domainMeta = DOMAIN_BY_ID[activeDomainId];
  const effectiveRegime = domainMeta.defaultRegime;
  const effectiveHarness: HarnessId | "all" =
    activeDomainId === "harnesses" && urlState.harnessTab === "stacks" ? urlState.harness : "all";
  const effectiveProviders: ProviderId[] = urlState.providers;
  const isControlledHarnesses =
    !isHome && activeDomainId === "harnesses" && urlState.harnessTab === "controlled";

  const activeDomainStaleRegime = !isHome && domain !== null && !domain.regimeMeta[effectiveRegime];
  const allDomainsLoaded = release.hydratedFull && !activeDomainStaleRegime;
  const needsActiveDomain =
    !isHome &&
    (isControlledHarnesses
      ? release.harnessLeaderboard === null
      : domain === null || activeDomainStaleRegime);
  const needsDrawerData = drawerOpen && (!release.hydratedFull || activeLifecycle === null);
  const needsImmediateFetch =
    needsActiveDomain || needsDrawerData || (requestedObservations && !release.hydratedFull);

  // Lazily hydrate remaining domains from /api/snapshot and adopt an entire release atomically without ever rolling backward
  useEffect(() => {
    if (!needsImmediateFetch || domainFetchError) return;
    if (activeDomainStaleRegime) {
      snapshotPromiseRef.current = null;
    }
    let cancelled = false;
    const minGeneratedAt = activeMeta.generatedAt;
    const ssrHash = activeMeta.snapshotHash;

    const parseFreshPayload = async (
      res: Response,
    ): Promise<{ snapshot: ProChoiceSnapshot; lifecycle: LifecycleReport } | null> => {
      if (!res.ok) return null;
      const body = (await res.json()) as {
        snapshot?: ProChoiceSnapshot;
        lifecycle?: LifecycleReport;
      };
      if (!body.snapshot?.domains || !body.snapshot.harnessLeaderboard || !body.lifecycle) {
        return null;
      }
      if (
        body.snapshot.generatedAt !== body.lifecycle.auditedAt ||
        !Array.isArray(body.lifecycle.sourceSensitivity) ||
        !Array.isArray(body.lifecycle.rankEvidence) ||
        DOMAINS.some((meta) => body.snapshot?.domains[meta.id]?.epochVersion !== meta.epochVersion)
      )
        return null;
      const cmp = compareIsoInstants(body.snapshot.generatedAt, minGeneratedAt);
      if (cmp === null || cmp < 0) return null;
      return { snapshot: body.snapshot, lifecycle: body.lifecycle };
    };

    const loadRelease = () => {
      if (!snapshotPromiseRef.current) {
        snapshotPromiseRef.current = (async () => {
          try {
            const first = await parseFreshPayload(await fetch("/api/snapshot"));
            if (first) return first;
            return await parseFreshPayload(
              await fetch(`/api/snapshot?_h=${encodeURIComponent(ssrHash)}`, {
                cache: "no-store",
              }),
            );
          } catch {
            return null;
          }
        })().then((payload) => {
          if (!payload) snapshotPromiseRef.current = null;
          return payload;
        });
      }
      void snapshotPromiseRef.current.then((payload) => {
        if (cancelled) return;
        if (payload) {
          setRelease((prev) => {
            const cmp = compareIsoInstants(payload.snapshot.generatedAt, prev.meta.generatedAt);
            if (cmp === null || cmp < 0) return prev;
            return {
              meta: {
                schemaVersion: payload.snapshot.schemaVersion,
                generatedAt: payload.snapshot.generatedAt,
                snapshotHash: payload.snapshot.snapshotHash,
                sources: payload.snapshot.sources,
              },
              domains: payload.snapshot.domains,
              harnessLeaderboard: payload.snapshot.harnessLeaderboard,
              lifecycle: payload.lifecycle,
              hydratedFull: true,
            };
          });
          setDomainFetchError(false);
        } else {
          setDomainFetchError(true);
        }
      });
    };

    loadRelease();
    return () => {
      cancelled = true;
    };
  }, [
    activeDomainStaleRegime,
    needsImmediateFetch,
    domainFetchError,
    activeMeta.generatedAt,
    activeMeta.snapshotHash,
  ]);

  useEffect(() => {
    const onPopState = () => {
      setNavMotion({ viewDir: 0, tabDx: 0 });
      setDrawerOpen(false);
      setDomainFetchError(false);
      setHarnessSliceDx(0);
    };
    const applyHash = () => {
      const h = window.location.hash;
      if (h.startsWith("#pruned-")) {
        try {
          const decoded = decodeURIComponent(h.slice("#pruned-".length));
          if (decoded) {
            setPrunedSectionOpen(true);
            setExpandedPrunedIds([decoded]);
          }
        } catch {
          setExpandedPrunedIds([]);
        }
        return;
      }
      if (!h.startsWith("#config-")) {
        setExpandedConfigIds([]);
        return;
      }
      try {
        const decoded = decodeURIComponent(h.slice("#config-".length));
        setExpandedConfigIds(decoded ? [decoded] : []);
      } catch {
        setExpandedConfigIds([]);
      }
    };
    applyHash();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", applyHash);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", applyHash);
    };
  }, []);

  useEffect(() => {
    document.title =
      urlState.view === "home"
        ? SITE_TITLE
        : `${DOMAIN_BY_ID[urlState.view].indexTitle} | ${SITE_NAME}`;
  }, [urlState.view]);

  // Canonicalize legacy /?d=<domain> links locally when visited without edge redirects
  useEffect(() => {
    if (!window.location.search.includes("d=")) return;
    const normalized = serializeGalleryUrl(
      parseGalleryUrl(window.location.pathname, window.location.search),
    );
    const desired = `${normalized}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== desired) {
      window.history.replaceState(null, "", desired);
      window.dispatchEvent(new Event(URL_CHANGE_EVENT));
    }
  }, []);

  useEffect(() => {
    if (!hasSyncedConfigHashRef.current) {
      hasSyncedConfigHashRef.current = true;
      return;
    }
    if (selectedConfigId !== null || window.location.hash.startsWith("#config-")) {
      syncConfigHash(selectedConfigId);
    }
  }, [selectedConfigId]);

  const updateUrl = (patch: Partial<GalleryUrlState>, keepHash = false, pushHistory = false) => {
    pushUrlState({ ...urlState, ...patch }, keepHash, pushHistory);
  };

  const toggleTheme = () => {
    const nextDark = !isDark;
    const nextTheme = nextDark ? "dark" : "light";
    const sysDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const apply = () => {
      document.documentElement.setAttribute("data-theme", nextTheme);
      try {
        if (nextDark === sysDark) {
          localStorage.removeItem("prochoice-theme");
        } else {
          localStorage.setItem("prochoice-theme", nextTheme);
        }
      } catch {
        // storage disabled
      }
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    };

    const docWithVt = document as Document & {
      startViewTransition?: (cb: () => void) => void;
    };
    const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (docWithVt.startViewTransition && !prefersReduced) {
      docWithVt.startViewTransition(() => {
        flushSync(apply);
      });
    } else {
      apply();
    }
  };

  const applyNavDirection = (nextView: GalleryUrlState["view"], nextHarnessTab: HarnessViewTab) => {
    const prevIdx = getViewNavIndex(urlState.view);
    const nextIdx = getViewNavIndex(nextView);
    const viewDir: -1 | 0 | 1 =
      urlState.view !== nextView && nextIdx !== prevIdx ? (nextIdx > prevIdx ? 1 : -1) : 0;
    const tabDx =
      urlState.view === "harnesses" &&
      nextView === "harnesses" &&
      urlState.harnessTab !== nextHarnessTab
        ? nextHarnessTab === "stacks"
          ? -18
          : 18
        : 0;
    setNavMotion({ viewDir, tabDx });
  };

  const handleGoHome = () => {
    applyNavDirection("home", urlState.harnessTab);
    setDrawerOpen(false);
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    updateUrl({ view: "home", harness: "all" }, false, true);
  };

  const handleSelectDomain = (nextDomain: DomainId) => {
    const nextHarnessTab = nextDomain === "harnesses" ? "controlled" : urlState.harnessTab;
    applyNavDirection(nextDomain, nextHarnessTab);
    setDrawerOpen(false);
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    setDomainFetchError(false);
    setSliceVisit((v) => v + 1);
    updateUrl(
      {
        view: nextDomain,
        harness: "all",
        harnessTab: nextHarnessTab,
      },
      false,
      true,
    );
  };

  const handleSoloProvider = (pid: ProviderId) => {
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    updateUrl({ providers: [pid] });
  };

  const handleToggleProvider = (pid: ProviderId) => {
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);

    const exists = urlState.providers.includes(pid);
    if (exists) {
      const next = urlState.providers.filter((p) => p !== pid);
      if (next.length === 0) return;
      updateUrl({ providers: next });
    } else {
      updateUrl({ providers: [...urlState.providers, pid] });
    }
  };

  const handleSelectAllProviders = () => {
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    updateUrl({ providers: [...ALL_PROVIDER_IDS] });
  };

  const handleResetProviders = () => {
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    updateUrl({ providers: [...WESTERN_PROVIDER_IDS] });
  };

  const handleSelectHarnessTab = (nextTab: HarnessViewTab) => {
    applyNavDirection("harnesses", nextTab);
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    setSliceVisit((v) => v + 1);
    updateUrl({ harnessTab: nextTab, harness: "all" }, false, true);
  };

  const handleSelectHarnessModel = (sliceId: string) => {
    const slices = release.harnessLeaderboard?.slices ?? [];
    const prevIdx = slices.findIndex((s) => s.sliceId === urlState.harnessModel);
    const nextIdx = slices.findIndex((s) => s.sliceId === sliceId);
    const dx =
      prevIdx !== -1 && nextIdx !== -1 && prevIdx !== nextIdx ? (nextIdx > prevIdx ? -12 : 12) : 0;
    setHarnessSliceDx(dx);
    updateUrl({ harnessModel: sliceId }, false, true);
  };

  const handleSelectHarness = (nextHarness: HarnessId | "all") => {
    setExpandedConfigIds([]);
    setExpandedPrunedIds([]);
    setHoveredConfigId(null);
    updateUrl({ harness: nextHarness });
  };

  const handleTogglePruned = (next: boolean) => {
    updateUrl({ showPruned: next }, true);
  };

  const handleSelectConfig = (id: string, scrollAndFocus = false) => {
    setExpandedConfigIds((prev) =>
      scrollAndFocus
        ? [...prev.filter((item) => item !== id), id]
        : prev.includes(id)
          ? prev.filter((item) => item !== id)
          : [...prev, id],
    );
    if (scrollAndFocus) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const rowId = `config-${encodeURIComponent(id)}`;
          const row = document.getElementById(rowId);
          const details = document.getElementById(`${rowId}-details`);
          const scrollTarget = row ?? details;
          if (scrollTarget) {
            const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            scrollTarget.scrollIntoView({
              behavior: reducedMotion ? "auto" : "smooth",
              block: "center",
            });
            (details ?? scrollTarget).focus({ preventScroll: true });
          }
        });
      });
    }
  };

  const handleSelectPrunedConfig = (id: string, scrollAndFocus = false) => {
    if (scrollAndFocus) {
      setPrunedSectionOpen(true);
      setExpandedPrunedIds((prev) => [...prev.filter((item) => item !== id), id]);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const rowId = `pruned-${encodeURIComponent(id)}`;
          const row = document.getElementById(rowId);
          const details = document.getElementById(`${rowId}-details`);
          const scrollTarget = row ?? details;
          if (scrollTarget) {
            const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            scrollTarget.scrollIntoView({
              behavior: reducedMotion ? "auto" : "smooth",
              block: "center",
            });
            (details ?? scrollTarget).focus({ preventScroll: true });
          }
        });
      });
    } else {
      setExpandedPrunedIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
      );
    }
  };

  const onGlobalKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.repeat || isHome) return;
    if (activeDomainId === "harnesses" && urlState.harnessTab === "controlled") return;
    const targetEl = e.target as HTMLElement | null;
    const tag = targetEl?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || targetEl?.isContentEditable) {
      return;
    }
    if (e.code === "KeyP") {
      e.preventDefault();
      handleTogglePruned(!urlState.showPruned);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, []);

  const configById = new Map<string, EvaluatedConfig>();
  if (domain) {
    for (const cfg of domain.configs) configById.set(cfg.id, cfg);
    for (const cfg of domain.provisionalConfigs) configById.set(cfg.id, cfg);
  }

  const selectedProviderSet = new Set(effectiveProviders);
  const availableNativeHarnesses = domain
    ? [
        ...new Set([
          ...domain.configs
            .filter(
              (c) =>
                c.harnessRegime === "native" &&
                c.harness !== "direct" &&
                selectedProviderSet.has(c.provider),
            )
            .map((c) => c.harness),
          ...(domain.observedBenchmarks ?? []).flatMap((bm) =>
            bm.rows
              .filter((row) => row.harness !== "direct" && selectedProviderSet.has(row.provider))
              .map((row) => row.harness),
          ),
        ]),
      ]
    : [];

  const visibleFrontiers: ProviderFrontier[] = [];
  if (domain) {
    for (const pid of effectiveProviders) {
      const match = domain.frontiers.find(
        (f) =>
          f.provider === pid &&
          f.harnessRegime === effectiveRegime &&
          f.harnessFilter === effectiveHarness,
      );
      if (match && match.frontier.length > 0) {
        visibleFrontiers.push(match);
      }
    }
  }

  const visibleEligibleConfigs = domain
    ? domain.configs.filter(
        (c) =>
          selectedProviderSet.has(c.provider) &&
          c.harnessRegime === effectiveRegime &&
          c.eligibleForFrontier &&
          c.effectiveCostUsd !== null &&
          (effectiveHarness === "all" || c.harness === effectiveHarness),
      )
    : [];

  const visibleProvisional = domain
    ? domain.provisionalConfigs.filter(
        (c) =>
          effectiveProviders.includes(c.provider) &&
          c.harnessRegime === effectiveRegime &&
          (effectiveHarness === "all" || c.harness === effectiveHarness),
      )
    : [];

  const displayedFrontierConfigIds = new Set<string>();
  for (const pf of visibleFrontiers) {
    for (const pt of pf.frontier) displayedFrontierConfigIds.add(pt.configId);
  }
  const hasDisplayedListTariffs = [...displayedFrontierConfigIds].some((id) => {
    const cfg = configById.get(id);
    return cfg !== undefined && cfg.inputPer1mUsd !== null && cfg.outputPer1mUsd !== null;
  });

  const liveHomeSummaries =
    allDomainsLoaded && release.harnessLeaderboard
      ? buildHomeSummaries(
          release.domains as Record<DomainId, DomainSnapshot>,
          release.harnessLeaderboard,
        )
      : homeSummaries;

  return (
    <div className="min-h-screen bg-(--bg) text-(--ink)">
      {/* Mobile sticky top bar */}
      <header className="sticky top-0 z-30 border-b border-(--border) bg-(--bg)/95 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link
            href="/"
            prefetch={false}
            onClick={(e) => {
              if (isModifiedClick(e)) return;
              e.preventDefault();
              handleGoHome();
            }}
            className="flex cursor-pointer items-center gap-2 text-left"
          >
            <BrandMark />
            <span className="font-display text-[17px] font-medium tracking-[-0.02em]">
              prochoice
            </span>
          </Link>
          <button
            type="button"
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-(--ink-muted) hover:bg-(--surface-hover) hover:text-(--ink)"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
        <nav
          aria-label="Domains"
          className="no-scrollbar flex gap-1 overflow-x-auto border-t border-(--border)/70 px-3 py-1.5 text-[13px]"
        >
          {DOMAINS.map((d) => {
            const active = !isHome && activeDomainId === d.id;
            return (
              <Link
                key={d.id}
                href={domainToPathname(d.id)}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                onClick={(e) => {
                  if (isModifiedClick(e)) return;
                  e.preventDefault();
                  handleSelectDomain(d.id);
                }}
                className={`shrink-0 cursor-pointer rounded-md px-2.5 py-1 transition-colors ${
                  active
                    ? "bg-(--subtle) font-medium text-(--ink)"
                    : "text-(--ink-muted) hover:text-(--ink)"
                }`}
              >
                {d.shortLabel}
              </Link>
            );
          })}
        </nav>
      </header>

      <div className="mx-auto flex max-w-315 flex-col lg:flex-row">
        {/* Desktop left sticky navigation rail aligned with page top padding and footer baseline */}
        <aside className="hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-50 lg:shrink-0 lg:flex-col lg:justify-between lg:px-6 lg:pt-24 lg:pb-0">
          <div>
            <Link
              href="/"
              prefetch={false}
              onClick={(e) => {
                if (isModifiedClick(e)) return;
                e.preventDefault();
                handleGoHome();
              }}
              aria-current={isHome ? "page" : undefined}
              className="group flex cursor-pointer items-center gap-2 text-left"
            >
              <BrandMark />
              <span className="font-display text-[17px] font-medium tracking-[-0.02em] text-(--ink)">
                prochoice
              </span>
            </Link>

            <nav
              aria-label="Domains"
              className="mt-8 flex flex-col items-start gap-2 text-[13.5px]"
            >
              {DOMAINS.map((d) => {
                const active = !isHome && activeDomainId === d.id;
                return (
                  <Link
                    key={d.id}
                    href={domainToPathname(d.id)}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    onClick={(e) => {
                      if (isModifiedClick(e)) return;
                      e.preventDefault();
                      handleSelectDomain(d.id);
                    }}
                    className={`relative cursor-pointer pl-3 text-left transition-colors duration-150 ${
                      active ? "font-medium text-(--ink)" : "text-(--ink-faint) hover:text-(--ink)"
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="sidebar-active-indicator"
                        aria-hidden="true"
                        transition={prefersReducedMotion ? { duration: 0 } : TAB_SPRING}
                        className="absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-(--ink)"
                      />
                    ) : null}
                    <span>{d.shortLabel}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex h-16.5 items-center">
            <button
              type="button"
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
              title={isDark ? "Light mode" : "Dark mode"}
              onClick={toggleTheme}
              className="-ml-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-(--ink-faint) transition-colors hover:bg-(--surface-hover) hover:text-(--ink)"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </aside>

        {/* Central hairline-framed content column */}
        <main className="flex min-h-screen min-w-0 flex-1 flex-col overflow-x-clip lg:border-x lg:border-(--border)">
          <motion.div
            key={urlState.view}
            initial={
              navMotion.viewDir === 0 || prefersReducedMotion
                ? false
                : isDesktopViewport
                  ? { opacity: 0, y: navMotion.viewDir * -18 }
                  : { opacity: 0, x: navMotion.viewDir * -18 }
            }
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2, ease: VIEW_EASE }}
            className="flex-1"
          >
            {isHome ? (
              <HomeView summaries={liveHomeSummaries} onSelectDomain={handleSelectDomain} />
            ) : (
              <>
                <section
                  className={`px-5 pt-12 sm:px-9 sm:pt-16 lg:px-11 lg:pt-24 ${
                    activeDomainId === "harnesses" ? "pb-5" : "pb-6 lg:pb-7"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h1 className="font-display text-[32px] leading-[1.1] font-normal tracking-tight text-(--ink) sm:text-[36px]">
                      {domainMeta.indexTitle}
                    </h1>
                    {!needsActiveDomain ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (domainFetchError) {
                            window.location.reload();
                            return;
                          }
                          setDrawerOpen(true);
                        }}
                        aria-busy={needsDrawerData && !domainFetchError}
                        className="cursor-pointer text-[12.5px] text-(--ink-faint) underline-offset-4 transition-colors hover:text-(--ink) hover:underline"
                      >
                        {needsDrawerData
                          ? domainFetchError
                            ? "Reload to open methodology"
                            : "Loading methodology…"
                          : "Methodology"}
                      </button>
                    ) : null}
                  </div>

                  {activeDomainId !== "harnesses" && (
                    <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-(--ink-muted)">
                      {domainMeta.description}
                    </p>
                  )}

                  {activeDomainId === "harnesses" ? (
                    <div
                      role="tablist"
                      aria-label="Harness views"
                      className="mt-5 inline-flex rounded-md border border-(--border) bg-(--subtle) p-0.5 text-[12.5px]"
                    >
                      {(
                        [
                          { id: "controlled", label: "Harnesses only" },
                          { id: "stacks", label: "Harness + model" },
                        ] as const
                      ).map((tab) => {
                        const active = urlState.harnessTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => handleSelectHarnessTab(tab.id)}
                            className={`relative cursor-pointer rounded-[5px] px-3 py-1 transition-colors duration-150 ${
                              active
                                ? "font-medium text-(--ink)"
                                : "text-(--ink-muted) hover:text-(--ink)"
                            }`}
                          >
                            {active ? (
                              <motion.span
                                layoutId="harnesses-tab-pill"
                                aria-hidden="true"
                                transition={prefersReducedMotion ? { duration: 0 } : TAB_SPRING}
                                className="absolute inset-0 rounded-[5px] bg-(--surface) shadow-(--shadow-button)"
                              />
                            ) : null}
                            <span className="relative z-10">{tab.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-5">
                      <ProviderPicker
                        selectedProviders={effectiveProviders}
                        showPruned={urlState.showPruned}
                        showHarnessFilter={false}
                        harnessFilter={effectiveHarness}
                        availableNativeHarnesses={availableNativeHarnesses}
                        onToggleProvider={handleToggleProvider}
                        onSoloProvider={handleSoloProvider}
                        onSelectAllProviders={handleSelectAllProviders}
                        onResetProviders={handleResetProviders}
                        onSelectHarness={handleSelectHarness}
                        onTogglePruned={handleTogglePruned}
                      />
                    </div>
                  )}
                  {activeDomainId === "harnesses" && urlState.harnessTab === "stacks" && (
                    <p className="mt-3 text-[13px] text-(--ink-muted)">
                      The chart compares software engineering scores.{" "}
                      <a href="#additional-results" className="underline underline-offset-4">
                        Other task results
                      </a>{" "}
                      are listed by benchmark below.
                    </p>
                  )}
                </section>

                <motion.div
                  key={
                    activeDomainId === "harnesses" ? `htab-${urlState.harnessTab}` : "domain-body"
                  }
                  role={activeDomainId === "harnesses" ? "tabpanel" : undefined}
                  initial={
                    activeDomainId === "harnesses" && navMotion.tabDx !== 0 && !prefersReducedMotion
                      ? { opacity: 0, x: navMotion.tabDx }
                      : false
                  }
                  animate={{ opacity: 1, x: 0 }}
                  transition={
                    prefersReducedMotion ? { duration: 0 } : { duration: 0.2, ease: VIEW_EASE }
                  }
                >
                  {activeDomainId === "harnesses" ? (
                    <div className="px-5 pb-6 sm:px-9 lg:px-11 lg:pb-7">
                      {isControlledHarnesses ? (
                        release.harnessLeaderboard && (
                          <ControlledBoardPicker
                            leaderboard={release.harnessLeaderboard}
                            sliceId={urlState.harnessModel}
                            onSelect={handleSelectHarnessModel}
                          />
                        )
                      ) : (
                        <ProviderPicker
                          selectedProviders={effectiveProviders}
                          showPruned={urlState.showPruned}
                          showHarnessFilter
                          harnessFilter={effectiveHarness}
                          availableNativeHarnesses={availableNativeHarnesses}
                          onToggleProvider={handleToggleProvider}
                          onSoloProvider={handleSoloProvider}
                          onSelectAllProviders={handleSelectAllProviders}
                          onResetProviders={handleResetProviders}
                          onSelectHarness={handleSelectHarness}
                          onTogglePruned={handleTogglePruned}
                        />
                      )}
                    </div>
                  ) : null}

                  {isControlledHarnesses && release.harnessLeaderboard ? (
                    <HarnessesControlledView
                      leaderboard={release.harnessLeaderboard}
                      selectedModelSlice={urlState.harnessModel}
                      sliceMotionDx={harnessSliceDx}
                    />
                  ) : needsActiveDomain || !domain ? (
                    domainFetchError ? (
                      <div className="flex items-center justify-between gap-4 border-t border-(--border) px-5 py-12 font-mono text-[12px] text-(--ink-muted) sm:px-9 lg:px-11">
                        <span>Could not load {domainMeta.indexTitle} snapshot.</span>
                        <button
                          type="button"
                          onClick={() => window.location.reload()}
                          className="cursor-pointer rounded border border-(--border-strong) px-2.5 py-1 text-(--ink) hover:bg-(--surface-hover)"
                        >
                          Reload page
                        </button>
                      </div>
                    ) : (
                      <section aria-busy="true" aria-label={`Loading ${domainMeta.indexTitle}`}>
                        <div className="grid grid-cols-1 divide-y divide-(--border) border-t border-(--border) md:grid-cols-3 md:divide-x md:divide-y-0">
                          {[0, 1, 2].map((slot) => (
                            <div
                              key={slot}
                              className="bg-(--surface) px-5 py-6 sm:px-7 lg:first:pl-11 lg:last:pr-11"
                            >
                              <div className="flex items-center justify-between">
                                <div className="h-3 w-16 animate-pulse rounded bg-(--subtle)" />
                                <div className="h-3 w-14 animate-pulse rounded bg-(--subtle)" />
                              </div>
                              <div className="mt-3 h-6 w-36 animate-pulse rounded bg-(--subtle)" />
                              <div className="mt-2 h-3 w-20 animate-pulse rounded bg-(--subtle)/75" />
                              <div className="mt-5 flex items-baseline justify-between border-t border-(--border)/60 pt-3">
                                <div className="h-5 w-16 animate-pulse rounded bg-(--subtle)" />
                                <div className="h-4 w-20 animate-pulse rounded bg-(--subtle)/80" />
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="flex h-105 items-center justify-center border-y border-(--border) bg-(--bg) px-5 sm:px-9 lg:px-11">
                          <svg
                            width="260"
                            height="92"
                            viewBox="0 0 260 92"
                            fill="none"
                            aria-hidden="true"
                            className="animate-pulse opacity-45"
                          >
                            <line
                              x1="12"
                              y1="78"
                              x2="248"
                              y2="78"
                              stroke="var(--border-strong)"
                              strokeWidth="1"
                            />
                            <path
                              d="M22 70 Q 92 28 238 14"
                              stroke="var(--ink-faint)"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                            />
                            <circle cx="22" cy="70" r="3.5" fill="var(--ink-faint)" />
                            <circle cx="104" cy="34" r="3.5" fill="var(--ink-faint)" />
                            <circle cx="238" cy="14" r="3.5" fill="var(--ink-faint)" />
                          </svg>
                        </div>
                      </section>
                    )
                  ) : (
                    <>
                      <VerdictPlacards
                        epochVersion={domain.epochVersion}
                        selectedProviders={effectiveProviders}
                        harnessFilter={effectiveHarness}
                        activeRegime={effectiveRegime}
                        isHarnessDomain={activeDomainId === "harnesses"}
                        anchorStats={domain.anchorStats}
                        linkJointCov={domain.regimeMeta[effectiveRegime]?.linkJointCov}
                        frontiers={visibleFrontiers}
                        eligibleConfigs={visibleEligibleConfigs}
                        configById={configById}
                        costUnit={domain.costUnit}
                        selectedConfigId={selectedConfigId}
                        hoveredConfigId={hoveredConfigId}
                        onSelectConfig={(id) => handleSelectConfig(id, true)}
                        onHoverConfig={setHoveredConfigId}
                      />

                      <ParetoPlate
                        domain={domain}
                        activeRegime={effectiveRegime}
                        isHarnessDomain={activeDomainId === "harnesses"}
                        sliceInstanceKey={`${domain.domainId}:${effectiveRegime}:${sliceVisit}`}
                        frontiers={visibleFrontiers}
                        configById={configById}
                        showPruned={urlState.showPruned}
                        hoveredConfigId={hoveredConfigId}
                        onSelectConfig={(id) => handleSelectConfig(id, true)}
                        onSelectPrunedConfig={(id) => handleSelectPrunedConfig(id, true)}
                        onHoverConfig={setHoveredConfigId}
                      />

                      <FrontierCatalogue
                        frontiers={visibleFrontiers}
                        configById={configById}
                        anchorStats={domain.anchorStats}
                        activeRegime={effectiveRegime}
                        priorMean={domain.regimeMeta[effectiveRegime]?.priorMean ?? 0}
                        isHarnessDomain={activeDomainId === "harnesses"}
                        costUnit={domain.costUnit}
                        expandedConfigIds={expandedConfigIds}
                        hoveredConfigId={hoveredConfigId}
                        onSelectConfig={(id) => handleSelectConfig(id, false)}
                        onHoverConfig={setHoveredConfigId}
                      />

                      <PrunedCatalogue
                        frontiers={visibleFrontiers}
                        configById={configById}
                        anchorStats={domain.anchorStats}
                        activeRegime={effectiveRegime}
                        priorMean={domain.regimeMeta[effectiveRegime]?.priorMean ?? 0}
                        costUnit={domain.costUnit}
                        isHarnessDomain={activeDomainId === "harnesses"}
                        open={prunedSectionOpen}
                        onOpenChange={setPrunedSectionOpen}
                        expandedPrunedIds={expandedPrunedIds}
                        onSelectPrunedConfig={(id) => handleSelectPrunedConfig(id, false)}
                      />
                      {domain.observedBenchmarks?.length ? (
                        <ObservedBenchmarkTables
                          key={domain.epochVersion}
                          ready={release.hydratedFull}
                          failed={domainFetchError}
                          requestRows={() => setRequestedObservations(true)}
                          showHarness={activeDomainId === "harnesses"}
                          benchmarks={domain.observedBenchmarks}
                          providers={selectedProviderSet}
                          harness={effectiveHarness}
                        />
                      ) : null}
                    </>
                  )}
                </motion.div>
              </>
            )}
          </motion.div>

          <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-(--border) px-5 py-6 text-[12px] leading-4.5 text-(--ink-faint) sm:px-9 lg:h-16.75 lg:py-0 lg:px-11">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-mono text-[11px] tabular">
                Updated {formatUtcDate(activeMeta.generatedAt)}
              </span>
              <Link href="/docs" className="transition-colors hover:text-(--ink)">
                API docs
              </Link>
              <Link href="/about" className="transition-colors hover:text-(--ink)">
                About
              </Link>
              <Link href="/contact" className="transition-colors hover:text-(--ink)">
                Contact
              </Link>
              <Link href="/privacy" className="transition-colors hover:text-(--ink)">
                Privacy
              </Link>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-(--ink)"
              >
                GitHub
              </a>
            </div>
            <span>
              © {formatUtcDate(activeMeta.generatedAt).slice(0, 4)}{" "}
              <a
                href={ORG_URL}
                target="_blank"
                rel="noreferrer"
                className="text-(--ink-muted) underline-offset-4 hover:text-(--ink) hover:underline"
              >
                {ORG_NAME}
              </a>
            </span>
          </footer>
        </main>
      </div>

      {domain && activeLifecycle && release.harnessLeaderboard ? (
        <EpochMonographDrawer
          open={drawerOpen && !isHome && !needsActiveDomain}
          onOpenChange={setDrawerOpen}
          domain={domain}
          activeRegime={effectiveRegime}
          activeHarnessTab={urlState.harnessTab}
          controlledSliceId={urlState.harnessModel}
          harnessLeaderboard={release.harnessLeaderboard}
          lifecycle={activeLifecycle}
          sources={activeMeta.sources}
          provisionalConfigs={visibleProvisional}
          hasDisplayedListTariffs={hasDisplayedListTariffs}
          generatedAt={activeMeta.generatedAt}
        />
      ) : null}
    </div>
  );
}
