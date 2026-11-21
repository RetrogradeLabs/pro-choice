import type { HarnessId, HarnessRegime } from "../lib/schema.ts";

export interface HarnessMeta {
  id: HarnessId;
  name: string;
  regime: HarnessRegime;
  userSelectable: boolean;
  aliases: readonly string[];
}

export const HARNESSES: readonly HarnessMeta[] = [
  {
    id: "direct",
    name: "Direct API",
    regime: "native",
    userSelectable: false,
    aliases: ["direct", "direct api", "direct-api", "api", "default", "native"],
  },
  {
    id: "multi-harness",
    name: "Composite harnesses",
    regime: "native",
    userSelectable: false,
    aliases: ["multi-harness", "composite"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    regime: "native",
    userSelectable: true,
    aliases: ["claude code", "claude-code", "claude_code", "claudecode"],
  },
  {
    id: "codex",
    name: "Codex",
    regime: "native",
    userSelectable: true,
    aliases: ["codex", "codex cli", "codex-cli", "codex_cli", "openai codex"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    regime: "native",
    userSelectable: true,
    aliases: [
      "antigravity",
      "antigravity cli",
      "antigravity-cli",
      "antigravity sdk",
      "antigravity-sdk",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    regime: "native",
    userSelectable: true,
    aliases: ["cursor", "cursor cli", "cursor-cli", "cursor ide"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    regime: "native",
    userSelectable: true,
    aliases: ["opencode", "opencode-v2", "open code"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    regime: "native",
    userSelectable: true,
    aliases: ["copilot", "github copilot", "copilot-cli", "copilot fusion"],
  },
  {
    id: "devin-cli",
    name: "Devin CLI",
    regime: "native",
    userSelectable: true,
    aliases: ["devin", "devin cli", "devin-cli", "devin fusion", "devin fusion cli"],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    regime: "native",
    userSelectable: true,
    aliases: ["grok build", "grok-build"],
  },
  {
    id: "muse-code",
    name: "Muse Code",
    regime: "native",
    userSelectable: true,
    aliases: ["muse code", "muse-code"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    regime: "native",
    userSelectable: true,
    aliases: ["gemini cli", "gemini-cli", "gemini_cli"],
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    regime: "native",
    userSelectable: true,
    aliases: ["kimi code", "kimi-code", "kimi_code", "kimi code cli", "kimi-code-cli"],
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    regime: "native",
    userSelectable: true,
    aliases: ["deepseek harness", "deepseek-harness", "deepseek_harness"],
  },
  {
    id: "mirror-cli",
    name: "Mirror CLI",
    regime: "native",
    userSelectable: true,
    aliases: ["mirror cli", "mirror-cli", "mirror_cli"],
  },
  {
    id: "factory",
    name: "Factory",
    regime: "native",
    userSelectable: false,
    aliases: ["factory", "factory droid", "factory-droid"],
  },
  {
    id: "standardized-suite",
    name: "AA Standardized Suite",
    regime: "standardized",
    userSelectable: false,
    aliases: ["standardized-suite", "aa-standardized-suite"],
  },
  {
    id: "mini-swe-agent",
    name: "mini-SWE-agent",
    regime: "standardized",
    userSelectable: false,
    aliases: ["mini-swe-agent", "mini-swe", "miniswe", "mini swe agent"],
  },
  {
    id: "openhands",
    name: "OpenHands",
    regime: "standardized",
    userSelectable: false,
    aliases: ["openhands", "open hands", "open-hands"],
  },
  {
    id: "harbor",
    name: "Harbor",
    regime: "standardized",
    userSelectable: false,
    aliases: ["harbor", "terminus", "terminus-2"],
  },
  {
    id: "stirrup",
    name: "Stirrup",
    regime: "standardized",
    userSelectable: false,
    aliases: ["stirrup"],
  },
  {
    id: "proximus",
    name: "Proximus",
    regime: "standardized",
    userSelectable: false,
    aliases: ["proximus"],
  },
] as const;

export const HARNESS_BY_ID: Readonly<Record<HarnessId, HarnessMeta>> = Object.fromEntries(
  HARNESSES.map((h) => [h.id, h]),
) as Record<HarnessId, HarnessMeta>;

export const NATIVE_SELECTABLE_HARNESSES: readonly HarnessMeta[] = HARNESSES.filter(
  (h) => h.regime === "native" && h.userSelectable,
);
