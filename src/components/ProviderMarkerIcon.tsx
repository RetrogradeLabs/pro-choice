import { PROVIDER_BY_ID, type ProviderMarker } from "@/config/providers";
import type { ProviderId } from "@/lib/schema";

export function markerPathAt(marker: ProviderMarker, cx: number, cy: number, r: number): string {
  switch (marker) {
    case "square": {
      const s = r * 0.88;
      return `M ${cx - s} ${cy - s} H ${cx + s} V ${cy + s} H ${cx - s} Z`;
    }
    case "diamond": {
      const d = r * 1.15;
      return `M ${cx} ${cy - d} L ${cx + d} ${cy} L ${cx} ${cy + d} L ${cx - d} ${cy} Z`;
    }
    case "triangleUp": {
      const h = r * 1.15;
      const w = r * 1.1;
      return `M ${cx} ${cy - h} L ${cx + w} ${cy + h * 0.8} L ${cx - w} ${cy + h * 0.8} Z`;
    }
    case "star": {
      const outer = r * 1.25;
      const inner = r * 0.42;
      return `M ${cx} ${cy - outer} L ${cx + inner} ${cy - inner} L ${cx + outer} ${cy} L ${cx + inner} ${cy + inner} L ${cx} ${cy + outer} L ${cx - inner} ${cy + inner} L ${cx - outer} ${cy} L ${cx - inner} ${cy - inner} Z`;
    }
    case "triangleDown": {
      const h = r * 1.15;
      const w = r * 1.1;
      return `M ${cx} ${cy + h} L ${cx + w} ${cy - h * 0.8} L ${cx - w} ${cy - h * 0.8} Z`;
    }
    case "pentagon": {
      const pts: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        pts.push(`${cx + r * 1.1 * Math.cos(ang)} ${cy + r * 1.1 * Math.sin(ang)}`);
      }
      return `M ${pts.join(" L ")} Z`;
    }
    case "hexagon": {
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const ang = (i * Math.PI) / 3;
        pts.push(`${cx + r * 1.1 * Math.cos(ang)} ${cy + r * 1.1 * Math.sin(ang)}`);
      }
      return `M ${pts.join(" L ")} Z`;
    }
    case "cross": {
      const a = r * 1.15;
      const b = r * 0.42;
      return `M ${cx - b} ${cy - a} H ${cx + b} V ${cy - b} H ${cx + a} V ${cy + b} H ${cx + b} V ${cy + a} H ${cx - b} V ${cy + b} H ${cx - a} V ${cy - b} H ${cx - b} Z`;
    }
    case "circle":
      return "";
  }
}

export function ProviderMarkerIcon({
  provider,
  size = 10,
}: {
  provider: ProviderId;
  size?: number;
}) {
  const meta = PROVIDER_BY_ID[provider];
  const half = size / 2;
  const r = size * 0.36;
  const d = markerPathAt(meta.marker, half, half, r);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="inline-block shrink-0"
    >
      {meta.marker === "circle" ? (
        <circle cx={half} cy={half} r={r} fill={meta.cssVar} />
      ) : (
        <path d={d} fill={meta.cssVar} />
      )}
    </svg>
  );
}
