import { controlledBoard, controlledBoardName } from "@/lib/controlled-boards";
import type { HarnessLeaderboardSnapshot } from "@/lib/schema";

export function ControlledBoardPicker({
  leaderboard,
  sliceId,
  onSelect,
}: {
  leaderboard: HarnessLeaderboardSnapshot;
  sliceId: string;
  onSelect: (id: string) => void;
}) {
  const { selected, pooled, controls } = controlledBoard(leaderboard, sliceId);
  const groups = [
    {
      label: "Benchmark",
      options: pooled.map((s) => ({
        id: s.sliceId,
        label: controlledBoardName(s),
        active: s.instrumentId === selected.instrumentId,
      })),
    },
    {
      label: "Test model",
      options: controls.map((s) => ({
        id: s.sliceId,
        label: s.label,
        active: s.sliceId === selected.sliceId,
      })),
    },
  ];
  return (
    <div className="space-y-1">
      {selected.sliceId !== sliceId && (
        <output className="text-xs text-(--ink-muted)">
          That control is unavailable in this release. Showing {controlledBoardName(selected)} with{" "}
          {selected.label}.
        </output>
      )}
      {groups.map((g) => (
        <fieldset
          key={g.label}
          aria-label={g.label}
          className="no-scrollbar flex min-h-8 items-center gap-1 overflow-x-auto text-[12px] sm:flex-wrap"
        >
          <span className="mr-1 shrink-0 font-mono text-[11px] text-(--ink-faint)">{g.label}</span>
          {g.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={opt.active}
              onClick={() => {
                if (!opt.active) onSelect(opt.id);
              }}
              className={`h-8 shrink-0 cursor-pointer rounded-md border px-2 whitespace-nowrap transition-colors ${opt.active ? "border-(--border-strong) bg-(--surface) font-medium text-(--ink)" : "border-transparent text-(--ink-muted) hover:bg-(--surface-hover)"}`}
            >
              {opt.label}
            </button>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
