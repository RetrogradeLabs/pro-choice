import { ImageResponse } from "next/og";
import { DOMAIN_BY_ID, DOMAINS } from "@/config/benchmarks";
import { controlledBoard } from "@/lib/controlled-boards";
import { formatScoreEvidence } from "@/lib/format";
import { buildHomeSummaries } from "@/lib/home-summaries";
import type { DomainId, ProChoiceSnapshot } from "@/lib/schema";
import { computeDomainHeadlineStats, formatUtcDate, SITE_NAME } from "@/lib/seo";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

function ChoiceForkLogo() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "9px",
          backgroundColor: "#ffffff",
          border: "1.5px solid rgba(17, 17, 17, 0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M10.5 13.1L5.2 7.8L7.4 5.6L12 10.2L10.5 13.1Z"
            fill="#111111"
            fillOpacity="0.28"
          />
          <path
            d="M10.4 20.5V11.8L16.3 5.9H12.4V3.2H20.8V11.6H18.1V7.7L13.2 12.6V20.5H10.4Z"
            fill="#111111"
          />
        </svg>
      </div>
      <span
        style={{
          fontSize: "24px",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "#111111",
        }}
      >
        prochoice
      </span>
    </div>
  );
}

export function renderHomeOgImage(snapshot: ProChoiceSnapshot): ImageResponse {
  const summaries = buildHomeSummaries(snapshot.domains, snapshot.harnessLeaderboard);
  const updated = formatUtcDate(snapshot.generatedAt);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#fafaf8",
        color: "#111111",
        padding: "56px 64px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <ChoiceForkLogo />
        <div
          style={{
            display: "flex",
            fontSize: "16px",
            color: "#68655e",
          }}
        >
          prochoice.industries · Updated {updated}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
        <div
          style={{
            fontSize: "54px",
            fontWeight: 500,
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
            color: "#111111",
          }}
        >
          No Nonsense LLM Leaderboards &amp; Rankings
        </div>
        <div
          style={{
            fontSize: "22px",
            lineHeight: 1.45,
            color: "#55534e",
            maxWidth: "960px",
          }}
        >
          Compare frontier AI models and coding agent harnesses by composite benchmark score and
          real dollar cost across six domains.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          borderTop: "1px solid rgba(17, 17, 17, 0.12)",
          borderLeft: "1px solid rgba(17, 17, 17, 0.12)",
          backgroundColor: "#ffffff",
        }}
      >
        {DOMAINS.map((meta) => {
          const sum = summaries.find((s) => s.domainId === meta.id);
          return (
            <div
              key={meta.id}
              style={{
                width: "33.33%",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "16px 20px",
                borderRight: "1px solid rgba(17, 17, 17, 0.12)",
                borderBottom: "1px solid rgba(17, 17, 17, 0.12)",
              }}
            >
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <span style={{ fontSize: "17px", fontWeight: 600, color: "#111111" }}>
                  {meta.shortLabel}
                </span>
                <span style={{ fontSize: "13px", color: "#2563eb", fontWeight: 600 }}>
                  {sum?.topPick?.metricText ?? ""}
                </span>
              </div>
              <div
                style={{
                  fontSize: "14px",
                  color: "#55534e",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
              >
                {sum?.topPick
                  ? `${sum.topPick.name} · ${sum.topPick.effort ?? ""} · ${sum.topPick.costText}`
                  : meta.label}
              </div>
              {sum?.topPick?.controlInterval && (
                <div
                  style={{ fontSize: 12, color: "#55534e" }}
                >{`Terminal-Bench 4.0 · ${sum.topPick.controlInterval}`}</div>
              )}
              {sum?.topPick?.evidence && (
                <div style={{ fontSize: 12, color: "#55534e" }}>
                  {`${formatScoreEvidence(sum.topPick.evidence)}${sum.topRecommended === false ? " · Estimate only" : ""}`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>,
    { ...OG_IMAGE_SIZE },
  );
}

export function renderDomainOgImage(
  domainId: DomainId,
  snapshot: ProChoiceSnapshot,
): ImageResponse {
  const meta = DOMAIN_BY_ID[domainId];
  const stats = computeDomainHeadlineStats(domainId, snapshot);
  const updated = formatUtcDate(snapshot.generatedAt);
  const cards = [
    {
      tag: "Lowest cost",
      text: stats.budgetLabel,
      evidence: stats.headlineEvidence.budget,
      accent: false,
    },
    {
      tag: domainId === "harnesses" ? "Cost–score tradeoff" : "Best value",
      text: stats.valueLabel,
      evidence: stats.headlineEvidence.bestValue,
      accent: domainId !== "harnesses",
    },
    {
      tag:
        domainId === "harnesses"
          ? "Highest pass rate"
          : stats.topRecommended
            ? "Top score"
            : "Highest estimate · estimate only",
      text: stats.topLabel,
      evidence: stats.headlineEvidence.topScore,
      accent: false,
    },
  ].filter((c) => c.text !== null);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#fafaf8",
        color: "#111111",
        padding: "56px 64px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <ChoiceForkLogo />
        <div style={{ display: "flex", fontSize: "16px", color: "#68655e" }}>
          {SITE_NAME} ·{" "}
          {domainId === "harnesses"
            ? controlledBoard(snapshot.harnessLeaderboard).selected.sourceVersion
            : snapshot.domains[domainId].epochVersion}{" "}
          · Updated {updated}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div
          style={{
            fontSize: "58px",
            fontWeight: 500,
            letterSpacing: "-0.03em",
            lineHeight: 1.06,
            color: "#111111",
          }}
        >
          {meta.indexTitle}
        </div>
        <div
          style={{
            fontSize: "22px",
            lineHeight: 1.45,
            color: "#55534e",
            maxWidth: "960px",
          }}
        >
          {domainId === "harnesses"
            ? controlledBoard(snapshot.harnessLeaderboard).scope
            : meta.description}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          border: "1px solid rgba(17, 17, 17, 0.12)",
          backgroundColor: "#ffffff",
        }}
      >
        {cards.map((card, idx) => (
          <div
            key={card.tag}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              padding: "24px 26px",
              borderLeft: idx > 0 ? "1px solid rgba(17, 17, 17, 0.12)" : "none",
              borderTop: card.accent ? "3px solid #2563eb" : "3px solid transparent",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: card.accent ? "#2563eb" : "#68655e",
              }}
            >
              {card.tag}
            </div>
            <div
              style={{
                fontSize: "21px",
                fontWeight: 600,
                lineHeight: 1.3,
                color: "#111111",
              }}
            >
              {card.text}
            </div>
            {card.evidence && (
              <div style={{ fontSize: 14, color: "#55534e" }}>
                {formatScoreEvidence(card.evidence)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    { ...OG_IMAGE_SIZE },
  );
}
