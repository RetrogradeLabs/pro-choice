import fs from "node:fs/promises";
import path from "node:path";
import { DOMAIN_BY_ID, DOMAINS } from "../../src/config/benchmarks.ts";
import {
  PROVIDER_BY_ID,
  type ProviderMarker,
  WESTERN_PROVIDER_IDS,
} from "../../src/config/providers.ts";
import { formatCost, formatScore } from "../../src/lib/format.ts";
import { buildHomeSummaries, type HomeDomainSummary } from "../../src/lib/home-summaries.ts";
import { buildWeightMapFromAnchors } from "../../src/lib/math/aggregate.ts";
import { selectControlledHarnessPicks } from "../../src/lib/math/harness-pareto.ts";
import { computeProviderFrontier, extractVerdictPicks } from "../../src/lib/math/pareto.ts";
import {
  type DomainId,
  type ProChoiceSnapshot,
  ProChoiceSnapshotSchema,
  type ProviderId,
} from "../../src/lib/schema.ts";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "data", "snapshot.json");
const README_PATH = path.join(ROOT, "README.md");
const LIGHT_SVG_PATH = path.join(ROOT, "docs", "assets", "index-matrix-light.svg");
const DARK_SVG_PATH = path.join(ROOT, "docs", "assets", "index-matrix-dark.svg");

const PROVIDER_HEX: Readonly<Record<ProviderId, { light: string; dark: string }>> = {
  anthropic: { light: "#b01e25", dark: "#ff7769" },
  openai: { light: "#006955", dark: "#2ac5a8" },
  google: { light: "#1d5bd6", dark: "#6aa9ff" },
  spacexai: { light: "#3a3f4b", dark: "#b0b6c4" },
  meta: { light: "#1c6099", dark: "#63b0f5" },
  deepseek: { light: "#5b3eb5", dark: "#a894ff" },
  moonshot: { light: "#966213", dark: "#e3b352" },
  alibaba: { light: "#9c2d8a", dark: "#e686d6" },
  zhipu: { light: "#2d7442", dark: "#6fc488" },
};

const CELL_COPY: Readonly<Record<DomainId, readonly [string, string]>> = {
  coding: ["Private repo engineering, systems ops,", "code migration, and live agentic coding."],
  writing: ["Live blind-arena creative writing and", "private held-out long-form scripts."],
  design_code: ["Live web, SVG, 3D, dataviz,", "mobile app, and slide blind arenas."],
  research: ["FrontierMath, ARC-AGI-3, science,", "finance, legal, and enterprise research."],
  cyber: ["Held-out CVE patching, private detection,", "and live attack-defense CTF matches."],
  harnesses: ["Coding agent harnesses on private stacks", "and fixed open-model control suites."],
};

const CELL_GEOMETRY: Readonly<
  Record<
    DomainId,
    {
      id: string;
      cellTx: number;
      cellTy: number;
      sparkTx: number;
      sparkTy: number;
      x0: number;
      y0: number;
    }
  >
> = {
  coding: { id: "cell-coding", cellTx: 0, cellTy: 48, sparkTx: 0, sparkTy: -40, x0: 348, y0: 100 },
  writing: {
    id: "cell-writing",
    cellTx: 480,
    cellTy: 48,
    sparkTx: -480,
    sparkTy: -40,
    x0: 828,
    y0: 100,
  },
  design_code: {
    id: "cell-design",
    cellTx: 0,
    cellTy: 209.5,
    sparkTx: 0,
    sparkTy: -200,
    x0: 348,
    y0: 260,
  },
  research: {
    id: "cell-research",
    cellTx: 480,
    cellTy: 209.5,
    sparkTx: -480,
    sparkTy: -200,
    x0: 828,
    y0: 260,
  },
  cyber: { id: "cell-cyber", cellTx: 0, cellTy: 371, sparkTx: 0, sparkTy: -360, x0: 348, y0: 420 },
  harnesses: {
    id: "cell-harnesses",
    cellTx: 480,
    cellTy: 371,
    sparkTx: -480,
    sparkTy: -360,
    x0: 828,
    y0: 420,
  },
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtCoord(n: number): string {
  const rounded = Number(n.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function renderMarker(marker: ProviderMarker, cx: number, cy: number, fill: string): string {
  switch (marker) {
    case "circle":
      return `<circle cx="${cx}" cy="${cy}" r="3.1" fill="${fill}" />`;
    case "square":
      return `<rect x="${fmtCoord(cx - 2.8)}" y="${fmtCoord(cy - 2.8)}" width="5.6" height="5.6" fill="${fill}" />`;
    case "triangleUp":
      return `<polygon points="${cx},${fmtCoord(cy - 3.4)} ${fmtCoord(cx + 3.4)},${fmtCoord(cy + 2.8)} ${fmtCoord(cx - 3.4)},${fmtCoord(cy + 2.8)}" fill="${fill}" />`;
    case "triangleDown":
      return `<polygon points="${fmtCoord(cx - 3.4)},${fmtCoord(cy - 2.8)} ${fmtCoord(cx + 3.4)},${fmtCoord(cy - 2.8)} ${cx},${fmtCoord(cy + 3.4)}" fill="${fill}" />`;
    case "diamond":
      return `<polygon points="${cx},${fmtCoord(cy - 3.4)} ${fmtCoord(cx + 3.4)},${cy} ${cx},${fmtCoord(cy + 3.4)} ${fmtCoord(cx - 3.4)},${cy}" fill="${fill}" />`;
    case "star":
      return `<polygon points="${cx},${fmtCoord(cy - 3.6)} ${fmtCoord(cx + 1.1)},${fmtCoord(cy - 1.1)} ${fmtCoord(cx + 3.6)},${cy} ${fmtCoord(cx + 1.1)},${fmtCoord(cy + 1.1)} ${cx},${fmtCoord(cy + 3.6)} ${fmtCoord(cx - 1.1)},${fmtCoord(cy + 1.1)} ${fmtCoord(cx - 3.6)},${cy} ${fmtCoord(cx - 1.1)},${fmtCoord(cy - 1.1)}" fill="${fill}" />`;
    case "pentagon":
      return `<polygon points="${cx},${fmtCoord(cy - 3.4)} ${fmtCoord(cx + 3.2)},${fmtCoord(cy - 1)} ${fmtCoord(cx + 2)},${fmtCoord(cy + 2.9)} ${fmtCoord(cx - 2)},${fmtCoord(cy + 2.9)} ${fmtCoord(cx - 3.2)},${fmtCoord(cy - 1)}" fill="${fill}" />`;
    case "hexagon":
      return `<polygon points="${fmtCoord(cx - 1.8)},${fmtCoord(cy - 3.1)} ${fmtCoord(cx + 1.8)},${fmtCoord(cy - 3.1)} ${fmtCoord(cx + 3.5)},${cy} ${fmtCoord(cx + 1.8)},${fmtCoord(cy + 3.1)} ${fmtCoord(cx - 1.8)},${fmtCoord(cy + 3.1)} ${fmtCoord(cx - 3.5)},${cy}" fill="${fill}" />`;
    case "cross":
      return `<path d="M${fmtCoord(cx - 3.1)} ${cy} H${fmtCoord(cx + 3.1)} M${cx} ${fmtCoord(cy - 3.1)} V${fmtCoord(cy + 3.1)}" stroke="${fill}" stroke-width="1.8" stroke-linecap="round" />`;
  }
}

function renderCellSvg(summary: HomeDomainSummary, theme: "light" | "dark"): string {
  const geom = CELL_GEOMETRY[summary.domainId];
  const [line1, line2] = CELL_COPY[summary.domainId];
  const pts = summary.sparkline.map((p) => ({
    x: Number((geom.x0 + 100 * p.x).toFixed(1)),
    y: Number((geom.y0 - 30 * p.y).toFixed(1)),
  }));

  let sparkMarkup = "";
  if (pts.length >= 2) {
    const linePath = `M${pts.map((p) => `${fmtCoord(p.x)} ${fmtCoord(p.y)}`).join(" L")}`;
    const areaPath = `${linePath} L${geom.x0 + 100} ${geom.y0} L${geom.x0} ${geom.y0} Z`;
    const dots: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const prev = dots[dots.length - 1];
      if (!prev || Math.hypot(pts[i]!.x - prev.x, pts[i]!.y - prev.y) >= 3.5) {
        dots.push(pts[i]!);
      }
    }
    const last = pts[pts.length - 1]!;
    sparkMarkup = [
      `      <g transform="translate(${geom.sparkTx}, ${geom.sparkTy})">`,
      `        <path class="spark-area" d="${areaPath}" />`,
      `        <path class="spark-line" d="${linePath}" />`,
      ...dots.map(
        (p) =>
          `        <circle cx="${fmtCoord(p.x)}" cy="${fmtCoord(p.y)}" r="1.8" class="spark-dot" />`,
      ),
      `        <circle cx="${fmtCoord(last.x)}" cy="${fmtCoord(last.y)}" r="2.8" class="spark-end" />`,
      `      </g>`,
    ].join("\n");
  }

  const top = summary.topPick;
  const sec = summary.secondaryPick;
  const topColor = top?.provider
    ? PROVIDER_HEX[top.provider][theme]
    : theme === "light"
      ? "#2563eb"
      : "#60a5fa";
  const secColor = sec?.provider
    ? PROVIDER_HEX[sec.provider][theme]
    : theme === "light"
      ? "#55534e"
      : "#a6a298";
  const topMarker: ProviderMarker = top?.provider ? PROVIDER_BY_ID[top.provider].marker : "circle";
  const secMarker: ProviderMarker = sec?.provider ? PROVIDER_BY_ID[sec.provider].marker : "circle";

  const topRow = top
    ? [
        `      <text x="28" y="116" class="label">Top score</text>`,
        `      ${renderMarker(topMarker, 105, 112, topColor)}`,
        `      <text x="116" y="116" clip-path="url(#name-clip)"><tspan class="top-name">${escapeXml(top.name)}</tspan>${
          top.effort ? `<tspan dx="7" class="effort">${escapeXml(top.effort)}</tspan>` : ""
        }</text>`,
        `      <text x="452" y="116" text-anchor="end" class="top-val">${escapeXml(`${top.metricText} · ${top.costText}`)}</text>`,
      ].join("\n")
    : "";

  const secRow = sec
    ? [
        `      <text x="28" y="139" class="label">${escapeXml(summary.secondaryTag)}</text>`,
        `      ${renderMarker(secMarker, 105, 135, secColor)}`,
        `      <text x="116" y="139" clip-path="url(#name-clip)"><tspan class="sec-name">${escapeXml(sec.name)}</tspan>${
          sec.effort ? `<tspan dx="7" class="effort">${escapeXml(sec.effort)}</tspan>` : ""
        }</text>`,
        `      <text x="452" y="139" text-anchor="end" class="sec-val">${escapeXml(`${sec.metricText} · ${sec.costText}`)}</text>`,
      ].join("\n")
    : "";

  return [
    `    <g id="${geom.id}" transform="translate(${geom.cellTx}, ${geom.cellTy})">`,
    `      <text x="28" y="36" class="domain">${escapeXml(summary.label)}<tspan dx="6" dy="-1" class="arrow">&#8594;</tspan></text>`,
    `      <text x="28" y="57" class="tagline">${escapeXml(line1)}</text>`,
    `      <text x="28" y="73" class="tagline">${escapeXml(line2)}</text>`,
    ``,
    sparkMarkup,
    ``,
    `      <line x1="28" y1="93" x2="452" y2="93" class="hairline" />`,
    ``,
    topRow,
    ``,
    secRow,
    `    </g>`,
  ].join("\n");
}

function renderMatrixSvg(
  summaries: readonly HomeDomainSummary[],
  benchmarkCount: number,
  dateStr: string,
  theme: "light" | "dark",
): string {
  const palette =
    theme === "light"
      ? {
          wordmark: "#111111",
          meta: "#68655e",
          arrow: "#8c877d",
          tagline: "#55534e",
          topName: "#111111",
          secName: "#333330",
          topVal: "#333330",
          secVal: "#55534e",
          hairline: "#e8e7e3",
          sparkArea: "#2563eb",
          sparkOpacity: "0.08",
          sparkLine: "#333330",
          sparkDot: "#111111",
          sparkEnd: "#2563eb",
          headerBg: "#fafaf8",
          bodyBg: "#ffffff",
          badgeBg: "#ffffff",
          badgeStroke: "#d4d2cb",
          logoInk: "#111111",
          logoGhost: "0.28",
          outerBorder: "#e2e0d9",
        }
      : {
          wordmark: "#f5f4f0",
          meta: "#989388",
          arrow: "#807b72",
          tagline: "#a6a298",
          topName: "#f5f4f0",
          secName: "#d8d5cc",
          topVal: "#d8d5cc",
          secVal: "#a6a298",
          hairline: "#312e2a",
          sparkArea: "#60a5fa",
          sparkOpacity: "0.12",
          sparkLine: "#d8d5cc",
          sparkDot: "#f5f4f0",
          sparkEnd: "#60a5fa",
          headerBg: "#1a1816",
          bodyBg: "#211f1c",
          badgeBg: "#211f1c",
          badgeStroke: "#44403a",
          logoInk: "#f5f4f0",
          logoGhost: "0.32",
          outerBorder: "#36332e",
        };

  const cells = summaries.map((s) => renderCellSvg(s, theme)).join("\n\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="568" viewBox="0 0 960 568" role="img" aria-label="ProChoice six composite index matrix across Coding, Writing, Design, Research, Cyber, and Harnesses">
  <title>ProChoice Composite Index Matrix</title>
  <defs>
    <clipPath id="frame-clip">
      <rect x="0" y="0" width="960" height="568" rx="8" />
    </clipPath>
    <clipPath id="name-clip">
      <rect x="114" y="96" width="236" height="56" />
    </clipPath>
    <style>
      .wordmark { font-family: Georgia, "Iowan Old Style", "Times New Roman", serif; font-size: 16.5px; font-weight: 500; letter-spacing: -0.02em; fill: ${palette.wordmark}; }
      .meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; fill: ${palette.meta}; }
      .domain { font-family: Georgia, "Iowan Old Style", "Times New Roman", serif; font-size: 21px; font-weight: 400; letter-spacing: -0.02em; fill: ${palette.wordmark}; }
      .arrow { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 400; fill: ${palette.arrow}; }
      .tagline { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12px; fill: ${palette.tagline}; }
      .label { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; fill: ${palette.meta}; }
      .top-name { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px; font-weight: 600; fill: ${palette.topName}; }
      .sec-name { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 12.5px; font-weight: 400; fill: ${palette.secName}; }
      .effort { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; font-weight: 400; fill: ${palette.meta}; }
      .top-val { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; fill: ${palette.topVal}; }
      .sec-val { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; fill: ${palette.secVal}; }
      .foot-url { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; fill: ${palette.topVal}; }
      .foot-note { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 11px; fill: ${palette.meta}; }
      .hairline { stroke: ${palette.hairline}; stroke-width: 1; }
      .spark-area { fill: ${palette.sparkArea}; fill-opacity: ${palette.sparkOpacity}; }
      .spark-line { fill: none; stroke: ${palette.sparkLine}; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .spark-dot { fill: ${palette.sparkDot}; }
      .spark-end { fill: ${palette.sparkEnd}; }
    </style>
  </defs>

  <g clip-path="url(#frame-clip)">
    <rect x="0" y="0" width="960" height="48" fill="${palette.headerBg}" />
    <rect x="0" y="48" width="960" height="484" fill="${palette.bodyBg}" />
    <rect x="0" y="532" width="960" height="36" fill="${palette.headerBg}" />

    <g id="header">
      <g transform="translate(28, 12)">
        <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="6" fill="${palette.badgeBg}" stroke="${palette.badgeStroke}" stroke-width="1.2" />
        <g transform="translate(2.65 4.15) scale(0.7)">
          <path d="M10.5 13.1L5.2 7.8L7.4 5.6L12 10.2L10.5 13.1Z" fill="${palette.logoInk}" fill-opacity="${palette.logoGhost}" />
          <path d="M10.4 20.5V11.8L16.3 5.9H12.4V3.2H20.8V11.6H18.1V7.7L13.2 12.6V20.5H10.4Z" fill="${palette.logoInk}" />
        </g>
      </g>
      <text x="61" y="29" class="wordmark">prochoice</text>
      <text x="932" y="28" text-anchor="end" class="meta">6 indices · ${benchmarkCount} benchmarks · ${dateStr}</text>
      <line x1="0" y1="48" x2="960" y2="48" class="hairline" />
    </g>

    <line x1="480" y1="48" x2="480" y2="532" class="hairline" />
    <line x1="0" y1="209.5" x2="960" y2="209.5" class="hairline" />
    <line x1="0" y1="371" x2="960" y2="371" class="hairline" />
    <line x1="0" y1="532" x2="960" y2="532" class="hairline" />

${cells}

    <g id="footer">
      <text x="28" y="554" class="foot-url">prochoice.industries</text>
      <text x="480" y="554" text-anchor="middle" class="foot-note">Models that cost more while scoring lower are left off the chart</text>
      <text x="932" y="554" text-anchor="end" class="foot-note">Retrograde Labs</text>
    </g>
  </g>

  <rect x="0.5" y="0.5" width="959" height="567" rx="8" fill="none" stroke="${palette.outerBorder}" stroke-width="1" />
</svg>
`;
}

function escapeMdCell(text: string): string {
  return text.replaceAll("$", "\\$").replaceAll("|", "\\|");
}

function countSnapshotActiveBenchmarks(snap: ProChoiceSnapshot): number {
  let total = 0;
  for (const meta of DOMAINS) {
    const dom = snap.domains[meta.id];
    const defReg = DOMAIN_BY_ID[meta.id].defaultRegime;
    total += dom.regimeMeta[defReg]?.activeBenchmarkIds.length ?? 0;
  }
  return total;
}

function buildReadmeLiveSection(
  snap: ProChoiceSnapshot,
  activeBenchmarkCount: number,
  dateStr: string,
): string {
  const western = new Set<string>(WESTERN_PROVIDER_IDS);
  const slugByDomain: Record<DomainId, string> = {
    coding: "coding",
    writing: "writing",
    design_code: "design",
    research: "research",
    cyber: "cyber",
    harnesses: "harnesses",
  };
  const rows: string[] = [];

  for (const meta of DOMAINS) {
    const dom = snap.domains[meta.id];
    const defReg = DOMAIN_BY_ID[meta.id].defaultRegime;
    const bmCount = dom.regimeMeta[defReg]?.activeBenchmarkIds.length ?? 0;
    const link = `[${meta.shortLabel}](https://prochoice.industries/${slugByDomain[meta.id]})`;

    if (meta.id === "harnesses") {
      const pooled =
        snap.harnessLeaderboard.slices.find((s) => s.sliceId === "_all") ??
        snap.harnessLeaderboard.slices[0];
      const picks = selectControlledHarnessPicks(pooled?.entries ?? []);
      const findPick = (tags: readonly string[]) => picks.find((p) => tags.includes(p.tag))?.entry;
      const fmtH = (e: ReturnType<typeof findPick>) =>
        e
          ? `${escapeMdCell(e.name)} at ${e.passRate.toFixed(1)}%, ${escapeMdCell(formatCost(e.costPerTrialUsd, "usd_per_task"))}`
          : "N/A";
      rows.push(
        `| ${link} | ${bmCount} (+3 controlled) | ${fmtH(findPick(["Budget"]))} | ${fmtH(findPick(["Best value"]))} | ${fmtH(findPick(["Top score", "Top pick"]))} |`,
      );
      continue;
    }

    const cfgs = dom.configs.filter(
      (c) => c.harnessRegime === defReg && western.has(c.provider) && c.effectiveCostUsd !== null,
    );
    const byId = new Map(cfgs.map((c) => [c.id, c]));
    const weights = buildWeightMapFromAnchors(dom.anchorStats, defReg);
    const rm = dom.regimeMeta[defReg];
    const env = computeProviderFrontier(
      cfgs,
      undefined,
      undefined,
      weights,
      dom.anchorStats,
      rm?.linkJointCov,
    );
    const verdicts = extractVerdictPicks(env.frontier, byId, {
      weightByBenchmark: weights,
      anchorStats: dom.anchorStats,
      ...(rm?.linkJointCov ? { linkJointCov: rm.linkJointCov } : {}),
      preferDistinctModelSlug: true,
    });
    const fmtM = (id: string | null) => {
      const c = id ? byId.get(id) : undefined;
      return c
        ? `${escapeMdCell(c.displayName)} at ${formatScore(c.score)}, ${escapeMdCell(formatCost(c.effectiveCostUsd, dom.costUnit))}`
        : "N/A";
    };
    rows.push(
      `| ${link} | ${bmCount} | ${fmtM(verdicts.budgetId)} | ${fmtM(verdicts.defaultId)} | ${fmtM(verdicts.maxId)} |`,
    );
  }

  return [
    `## Live composite indices`,
    ``,
    `Snapshot \`${snap.snapshotHash}\`, updated \`${dateStr}\` from ${snap.sources.length} live benchmark and first-party pricing feeds across ${activeBenchmarkCount} active private and live benchmarks with unique dataset lineages within each domain. Default model picks cover the five Western providers shown on initial load; toggle DeepSeek, Moonshot, Alibaba, and Zhipu on [prochoice.industries](https://prochoice.industries) to compare all nine.`,
    ``,
    `| Composite index | Active benchmarks | Budget | Best value | Top score |`,
    `| :--- | :---: | :--- | :--- | :--- |`,
    ...rows,
  ].join("\n");
}

async function writeIfChanged(filePath: string, nextContent: string): Promise<boolean> {
  const prev = await fs.readFile(filePath, "utf8").catch(() => null);
  if (prev === nextContent) return false;
  await fs.writeFile(filePath, nextContent, "utf8");
  return true;
}

export async function updateReadmeAndMatrixAssets(): Promise<{ changed: string[] }> {
  const snap = ProChoiceSnapshotSchema.parse(JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8")));
  const liveDateStr = snap.generatedAt.slice(0, 10);
  const forceDateBump = process.env.FORCE_README_DATE === "1";
  const summaries = buildHomeSummaries(snap.domains, snap.harnessLeaderboard);
  const activeBenchmarkCount = countSnapshotActiveBenchmarks(snap);

  const [readmePrev, lightPrev, darkPrev] = await Promise.all([
    fs.readFile(README_PATH, "utf8"),
    fs.readFile(LIGHT_SVG_PATH, "utf8").catch(() => null),
    fs.readFile(DARK_SVG_PATH, "utf8").catch(() => null),
  ]);
  const sectionRx = /## Live composite indices[\s\S]*?(?=\n\n## Why ProChoice)/;
  if (!sectionRx.test(readmePrev)) {
    throw new Error(
      "README.md missing expected '## Live composite indices' .. '## Why ProChoice' boundaries",
    );
  }

  // Keep existing date string on quiet days when snapshot hash, verdicts, and sparklines are unchanged
  const existingDateMatch = readmePrev.match(/Snapshot `[0-9a-f]+`, updated `(\d{4}-\d{2}-\d{2})`/);
  const existingDate = existingDateMatch?.[1] ?? null;
  if (!forceDateBump && existingDate && existingDate !== liveDateStr) {
    const probeReadme = readmePrev.replace(
      sectionRx,
      buildReadmeLiveSection(snap, activeBenchmarkCount, existingDate),
    );
    const probeLight = renderMatrixSvg(summaries, activeBenchmarkCount, existingDate, "light");
    const probeDark = renderMatrixSvg(summaries, activeBenchmarkCount, existingDate, "dark");
    if (probeReadme === readmePrev && probeLight === lightPrev && probeDark === darkPrev) {
      return { changed: [] };
    }
  }

  const lightSvg = renderMatrixSvg(summaries, activeBenchmarkCount, liveDateStr, "light");
  const darkSvg = renderMatrixSvg(summaries, activeBenchmarkCount, liveDateStr, "dark");
  const readmeNext = readmePrev.replace(
    sectionRx,
    buildReadmeLiveSection(snap, activeBenchmarkCount, liveDateStr),
  );

  const changed: string[] = [];
  if (await writeIfChanged(LIGHT_SVG_PATH, lightSvg)) {
    changed.push("docs/assets/index-matrix-light.svg");
  }
  if (await writeIfChanged(DARK_SVG_PATH, darkSvg)) {
    changed.push("docs/assets/index-matrix-dark.svg");
  }
  if (await writeIfChanged(README_PATH, readmeNext)) changed.push("README.md");
  return { changed };
}

if (import.meta.main) {
  updateReadmeAndMatrixAssets()
    .then(({ changed }) => {
      console.log(
        changed.length > 0
          ? `Updated README and matrix assets: ${changed.join(", ")}`
          : "README and index matrix SVGs already up to date.",
      );
    })
    .catch((err) => {
      console.error("Failed to update README assets:", err);
      process.exit(1);
    });
}
