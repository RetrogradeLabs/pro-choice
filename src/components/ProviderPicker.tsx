"use client";

import { HARNESS_BY_ID, NATIVE_SELECTABLE_HARNESSES } from "@/config/harnesses";
import {
  ALL_PROVIDER_IDS,
  CHINESE_PROVIDER_IDS,
  PROVIDER_BY_ID,
  WESTERN_PROVIDER_IDS,
} from "@/config/providers";
import type { HarnessId, ProviderId } from "@/lib/schema";
import { ProviderMarkerIcon } from "./ProviderMarkerIcon";

const EMPTY_HARNESSES: readonly HarnessId[] = [];

interface ProviderPickerProps {
  selectedProviders: readonly ProviderId[];
  showPruned: boolean;
  showHarnessFilter?: boolean;
  harnessFilter?: HarnessId | "all";
  availableNativeHarnesses?: readonly HarnessId[];
  onToggleProvider: (p: ProviderId) => void;
  onSoloProvider: (p: ProviderId) => void;
  onSelectAllProviders: () => void;
  onResetProviders: () => void;
  onSelectHarness?: (h: HarnessId | "all") => void;
  onTogglePruned: (next: boolean) => void;
}

export function ProviderPicker({
  selectedProviders,
  showPruned,
  showHarnessFilter = false,
  harnessFilter = "all",
  availableNativeHarnesses = EMPTY_HARNESSES,
  onToggleProvider,
  onSoloProvider,
  onSelectAllProviders,
  onResetProviders,
  onSelectHarness,
  onTogglePruned,
}: ProviderPickerProps) {
  const selectedSet = new Set(selectedProviders);
  const allProviders = [...WESTERN_PROVIDER_IDS, ...CHINESE_PROVIDER_IDS];
  const allSelected = selectedProviders.length === ALL_PROVIDER_IDS.length;

  const visibleNativeHarnesses = NATIVE_SELECTABLE_HARNESSES.filter(
    (h) => availableNativeHarnesses.includes(h.id) || harnessFilter === h.id,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="no-scrollbar flex max-w-full flex-nowrap items-center gap-1 overflow-x-auto sm:flex-wrap">
          {allProviders.map((pid, idx) => {
            const meta = PROVIDER_BY_ID[pid];
            const selected = selectedSet.has(pid);
            const isOnlySelected = selected && selectedProviders.length === 1;
            const showDivider = idx === WESTERN_PROVIDER_IDS.length;

            return (
              <span key={pid} className="inline-flex shrink-0 items-center">
                {showDivider ? (
                  <span
                    aria-hidden="true"
                    className="mx-1.5 hidden h-3.5 w-px bg-(--border) sm:inline-block"
                  />
                ) : null}

                <button
                  type="button"
                  aria-pressed={selected}
                  title={
                    isOnlySelected
                      ? `${meta.name} active`
                      : selected
                        ? `Hide ${meta.name}. Double-click or Shift+Enter to solo.`
                        : `Show ${meta.name}. Double-click or Shift+Enter to solo.`
                  }
                  onClick={() => onToggleProvider(pid)}
                  onDoubleClick={() => onSoloProvider(pid)}
                  onKeyDown={(e) => {
                    if (e.shiftKey && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onSoloProvider(pid);
                    }
                  }}
                  className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12.5px] transition-all duration-150 select-none active:scale-[0.98] ${
                    selected
                      ? "border-(--border-strong) bg-(--surface) font-medium text-(--ink)"
                      : "border-transparent bg-transparent font-normal text-(--ink-faint) hover:bg-(--surface-hover) hover:text-(--ink)"
                  }`}
                >
                  <span className={selected ? "opacity-100" : "opacity-45"}>
                    <ProviderMarkerIcon provider={pid} size={9} />
                  </span>
                  <span>{meta.shortName}</span>
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 text-[12px]">
          <button
            type="button"
            onClick={allSelected ? onResetProviders : onSelectAllProviders}
            className="h-7 cursor-pointer rounded-md px-2 text-(--ink-faint) transition-colors hover:bg-(--surface-hover) hover:text-(--ink)"
          >
            {allSelected ? "Reset" : `All ${allProviders.length}`}
          </button>

          <span aria-hidden="true" className="h-3 w-px bg-(--border)" />

          <button
            type="button"
            aria-pressed={showPruned}
            onClick={() => onTogglePruned(!showPruned)}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 transition-colors select-none ${
              showPruned
                ? "border-(--border-strong) bg-(--subtle) font-medium text-(--ink)"
                : "border-transparent text-(--ink-faint) hover:bg-(--surface-hover) hover:text-(--ink)"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rotate-45 border ${
                showPruned ? "border-(--ink) bg-(--ink)" : "border-(--ink-faint)"
              }`}
            />
            <span>Pruned</span>
          </button>
        </div>
      </div>

      {showHarnessFilter && onSelectHarness ? (
        <div className="flex flex-wrap items-center gap-1 border-t border-(--border)/70 pt-2.5 text-[12px]">
          <button
            type="button"
            aria-pressed={harnessFilter === "all"}
            onClick={() => onSelectHarness("all")}
            className={`h-7 cursor-pointer rounded-md border px-2.5 transition-colors ${
              harnessFilter === "all"
                ? "border-(--border-strong) bg-(--surface) font-medium text-(--ink)"
                : "border-transparent text-(--ink-faint) hover:bg-(--surface-hover) hover:text-(--ink)"
            }`}
          >
            Best harness
          </button>

          {visibleNativeHarnesses.map((h) => {
            const active = harnessFilter === h.id;
            const hasAny = availableNativeHarnesses.includes(h.id);
            const label = HARNESS_BY_ID[h.id].name;
            return (
              <button
                key={h.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectHarness(h.id)}
                className={`h-7 cursor-pointer rounded-md border px-2.5 transition-colors ${
                  active
                    ? "border-(--border-strong) bg-(--surface) font-medium text-(--ink)"
                    : "border-transparent text-(--ink-faint) hover:bg-(--surface-hover) hover:text-(--ink)"
                }`}
              >
                <span>{label}</span>
                {!hasAny ? (
                  <span className="ml-1 font-mono text-[10.5px] text-(--ink-faint)">0</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
