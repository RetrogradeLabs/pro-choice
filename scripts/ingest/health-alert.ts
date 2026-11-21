import fs from "node:fs/promises";
import path from "node:path";
import rawAliases from "../../src/config/aliases.json" with { type: "json" };
import {
  LifecycleReportSchema,
  ProChoiceSnapshotSchema,
  UnmappedRecordSchema,
} from "../../src/lib/schema.ts";

const STATIC_EXPLICIT_EFFORT_SLUGS = new Set(
  (rawAliases as readonly { modelSlug: string; requireExplicitEffort?: boolean }[])
    .filter((entry) => entry.requireExplicitEffort)
    .map((entry) => entry.modelSlug.toLowerCase()),
);

const ROOT = process.cwd();
const ALERT_LABEL = "automation-health";
const ALERT_TITLE = "[ProChoice Automation] Health and Lifecycle Alert";
const MIN_DEGRADED_ALERT_DAYS = 3;
const MIN_RECURRING_UNMAPPED_SOURCES = 3;
const MAX_GH_ATTEMPTS = 3;

const KNOWN_LEGACY_MODEL_RX =
  /^(?:chatgpt-4o|gpt-o[134]|gpt-(?:3\.5|4|4o|4\.1|4\.5|5|5\.\d)|o[134](?:\b|-)|claude-(?:3|4)(?:\b|[._-])|claude-(?:opus|sonnet|haiku)-4(?:[._-][01])?|gemini-(?:1|2)(?:\.|[- ])|gemma-[123](?:\b|[._-])|grok-(?:2|3|4(?:\b|-fast|-code|-1)|code-fast)|deepseek-(?:v2|v3|r1|chat|coder|reasoner)|kimi-k2(?:\.5)?(?:\b|-)|qwen-?[123](?:\b|[._-])|qwq-|glm-4(?:\b|[._-])|llama-[234](?:\b|[._-]))/i;

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

function sanitizeMdCell(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replaceAll("|", "\\|")
    .trim();
}

async function ghRequest<T>(
  repo: string,
  token: string,
  endpoint: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ProChoice-Automation/2.0",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (retryable && attempt + 1 < MAX_GH_ATTEMPTS) {
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return ghRequest<T>(repo, token, endpoint, init, attempt + 1);
    }
    const text = await res.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (attempt + 1 < MAX_GH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return ghRequest<T>(repo, token, endpoint, init, attempt + 1);
    }
    throw err;
  }
}

async function collectAlerts(jobStatus: string): Promise<{
  alerts: string[];
  details: string[];
  snapshotHash: string;
}> {
  const alerts: string[] = [];
  const details: string[] = [];
  let snapshotHash = "unavailable";

  if (jobStatus !== "success") {
    alerts.push(`Daily ingestion job exited with status \`${jobStatus}\`.`);
  }

  try {
    const snap = ProChoiceSnapshotSchema.parse(
      JSON.parse(await fs.readFile(path.join(ROOT, "data", "snapshot.json"), "utf8")),
    );
    snapshotHash = snap.snapshotHash;
    const degraded = snap.sources.filter(
      (s) =>
        s.status === "degraded" &&
        (s.staleDays >= MIN_DEGRADED_ALERT_DAYS || s.lastHealthyAt === null),
    );
    if (degraded.length > 0) {
      alerts.push(
        `${degraded.length} source adapter(s) degraded for >= ${MIN_DEGRADED_ALERT_DAYS} days.`,
      );
      details.push(
        "### Degraded sources",
        "",
        "| Source | Stale days | Last healthy | Message |",
        "| :--- | ---: | :--- | :--- |",
        ...degraded.map(
          (s) =>
            `| \`${s.sourceId}\` | ${s.staleDays} | ${s.lastHealthyAt ?? "never"} | ${sanitizeMdCell(s.message ?? "degraded").slice(0, 160)} |`,
        ),
        "",
      );
    }
  } catch (err) {
    alerts.push(
      `Failed to read or parse \`data/snapshot.json\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const report = LifecycleReportSchema.parse(
      JSON.parse(await fs.readFile(path.join(ROOT, "data", "lifecycle.json"), "utf8")),
    );
    const triggers = report.audits.filter((a) => a.status === "retire_trigger");
    if (triggers.length > 0) {
      alerts.push(`${triggers.length} active benchmark(s) reached sustained retirement trigger.`);
      details.push(
        "### Sustained benchmark retirement triggers",
        "",
        "| Benchmark | Domain | Trigger days | Saturation | Separability | Reasons |",
        "| :--- | :--- | ---: | ---: | ---: | :--- |",
        ...triggers.map(
          (t) =>
            `| \`${t.benchmarkId}\` | ${t.domainId} | ${t.consecutiveTriggerDays} | ${t.saturationIndex?.toFixed(2) ?? "N/A"} | ${t.separability !== null ? `${Math.round(t.separability * 100)}%` : "N/A"} | ${sanitizeMdCell(t.reasons.join("; "))} |`,
        ),
        "",
      );
    }
  } catch (err) {
    alerts.push(
      `Failed to read or parse \`data/lifecycle.json\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const rawUnmapped = JSON.parse(
      await fs.readFile(path.join(ROOT, "data", "unmapped.json"), "utf8"),
    ) as unknown[];
    const unmapped = rawUnmapped.map((u) => UnmappedRecordSchema.parse(u));
    const sourcesByCandidate = new Map<string, { kind: string; sources: Set<string> }>();
    for (const u of unmapped) {
      const prefixes = [
        ["unresolved_allowlisted_model:", "unresolved"],
        ["unverified_revision_date:", "revision_date"],
        ["ambiguous_mode_requires_explicit_effort:", "effort_default"],
      ] as const;
      let matchedPrefix: (typeof prefixes)[number] | null = null;
      for (const p of prefixes) {
        if (u.reason.startsWith(p[0])) {
          matchedPrefix = p;
          break;
        }
      }
      if (!matchedPrefix) continue;
      const candidate = u.reason.slice(matchedPrefix[0].length).trim();
      if (!candidate) continue;
      const key = candidate.toLowerCase().replace(/[\s_]+/g, "-");
      if (KNOWN_LEGACY_MODEL_RX.test(key)) continue;
      if (matchedPrefix[1] === "effort_default" && STATIC_EXPLICIT_EFFORT_SLUGS.has(key)) continue;
      const bucketKey = `${matchedPrefix[1]}::${key}`;
      const cur = sourcesByCandidate.get(bucketKey) ?? {
        kind: matchedPrefix[1],
        sources: new Set<string>(),
      };
      cur.sources.add(u.sourceId);
      sourcesByCandidate.set(bucketKey, cur);
    }
    const recurring = [...sourcesByCandidate.entries()]
      .filter(([, entry]) => entry.sources.size >= MIN_RECURRING_UNMAPPED_SOURCES)
      .toSorted((a, b) => b[1].sources.size - a[1].sources.size);
    if (recurring.length > 0) {
      alerts.push(
        `${recurring.length} recurring unmapped frontier model candidate(s) appeared across >= ${MIN_RECURRING_UNMAPPED_SOURCES} feeds.`,
      );
      details.push(
        "### Recurring unmapped frontier candidates",
        "",
        "| Candidate | Kind | Feed count | Sources |",
        "| :--- | :--- | ---: | :--- |",
        ...recurring
          .slice(0, 20)
          .map(
            ([bucketKey, entry]) =>
              `| \`${sanitizeMdCell(bucketKey.slice(bucketKey.indexOf("::") + 2))}\` | ${entry.kind} | ${entry.sources.size} | ${[...entry.sources].toSorted().join(", ")} |`,
          ),
        "",
      );
    }
  } catch {
    // Non-fatal if unmapped.json was not written before an early job failure
  }

  return { alerts, details, snapshotHash };
}

async function findOpenAlertIssues(repo: string, token: string): Promise<GitHubIssue[] | null> {
  const labeledRes = await ghRequest<GitHubIssue[]>(
    repo,
    token,
    `/issues?state=open&labels=${encodeURIComponent(ALERT_LABEL)}&per_page=100`,
  );
  if (!labeledRes.ok || !Array.isArray(labeledRes.data)) {
    console.warn(`Skipping GitHub alert sync: issue query returned HTTP ${labeledRes.status}`);
    return null;
  }
  const matched = labeledRes.data.filter(
    (item) => !item.pull_request && item.title === ALERT_TITLE,
  );
  if (matched.length > 0) return matched;

  const fallbackRes = await ghRequest<GitHubIssue[]>(
    repo,
    token,
    "/issues?state=open&per_page=100",
  );
  if (!fallbackRes.ok || !Array.isArray(fallbackRes.data)) return [];
  return fallbackRes.data.filter((item) => !item.pull_request && item.title === ALERT_TITLE);
}

async function closeAlertIssue(
  repo: string,
  token: string,
  issueNumber: number,
  commentBody: string,
): Promise<boolean> {
  const commentRes = await ghRequest(repo, token, `/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: commentBody }),
  });
  const closeRes = await ghRequest(repo, token, `/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  if (!commentRes.ok || !closeRes.ok) {
    console.warn(
      `Failed to close health alert issue #${issueNumber} (comment HTTP ${commentRes.status}, patch HTTP ${closeRes.status}).`,
    );
    return false;
  }
  console.log(`Closed resolved health alert issue #${issueNumber}.`);
  return true;
}

async function syncHealthIssue(): Promise<void> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  const jobStatus = process.env.JOB_STATUS?.trim() || "success";
  const serverUrl = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  const runId = process.env.GITHUB_RUN_ID?.trim();
  const runUrl = repo && runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : null;

  const { alerts, details, snapshotHash } = await collectAlerts(jobStatus);

  if (!token || !repo) {
    console.log(
      alerts.length === 0
        ? `Health check clean (snapshot ${snapshotHash}, no GitHub credentials configured).`
        : `Health check flagged ${alerts.length} alert(s) (no GitHub credentials configured): ${alerts.join(" | ")}`,
    );
    return;
  }

  const openAlerts = await findOpenAlertIssues(repo, token);
  if (openAlerts === null) return;

  if (alerts.length === 0) {
    if (openAlerts.length > 0) {
      const resolvedAt = new Date().toISOString();
      const note = `Resolved automatically at \`${resolvedAt}\` on snapshot \`${snapshotHash}\`.${runUrl ? ` Workflow run: ${runUrl}` : ""}`;
      await Promise.all(
        openAlerts.map((issue) => closeAlertIssue(repo, token, issue.number, note)),
      );
    } else {
      console.log(`Health check clean (snapshot ${snapshotHash}); no open alert issue.`);
    }
    return;
  }

  await ghRequest(repo, token, "/labels", {
    method: "POST",
    body: JSON.stringify({
      name: ALERT_LABEL,
      color: "b01e25",
      description: "Automated health and lifecycle alerts from daily ProChoice ingestion",
    }),
  }).catch(() => undefined);

  const nowIso = new Date().toISOString();
  const body = [
    `Updated \`${nowIso}\` for snapshot \`${snapshotHash}\`${runUrl ? ` from [workflow run](${runUrl})` : ""}.`,
    ``,
    `### Active alerts`,
    ``,
    ...alerts.map((a) => `- ${a}`),
    ``,
    ...details,
    `This issue updates automatically on each daily run and closes itself once all sources and lifecycle checks return healthy.`,
  ].join("\n");

  const primary = openAlerts[0];
  if (primary) {
    const patchRes = await ghRequest(repo, token, `/issues/${primary.number}`, {
      method: "PATCH",
      body: JSON.stringify({ title: ALERT_TITLE, body, labels: [ALERT_LABEL] }),
    });
    console.log(
      patchRes.ok
        ? `Updated health alert issue #${primary.number} with ${alerts.length} active alert(s).`
        : `Failed to update health alert issue #${primary.number}: HTTP ${patchRes.status}`,
    );
    const duplicates = openAlerts.slice(1);
    if (duplicates.length > 0) {
      await Promise.all(
        duplicates.map((dup) =>
          closeAlertIssue(repo, token, dup.number, `Consolidated into #${primary.number}.`),
        ),
      );
    }
  } else {
    const createRes = await ghRequest<GitHubIssue>(repo, token, "/issues", {
      method: "POST",
      body: JSON.stringify({ title: ALERT_TITLE, body, labels: [ALERT_LABEL] }),
    });
    console.log(
      createRes.ok && createRes.data
        ? `Opened health alert issue #${createRes.data.number} with ${alerts.length} active alert(s).`
        : `Failed to open health alert issue: HTTP ${createRes.status}`,
    );
  }
}

if (import.meta.main) {
  syncHealthIssue().catch((err) => {
    console.warn("Health alert sync encountered non-fatal error:", err);
  });
}
