"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

const THEME_CHANGE_EVENT = "prochoice-theme-change";

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

interface ThemeToggleButtonProps {
  variant: "desktop" | "mobile";
}

export function ThemeToggleButton({ variant }: ThemeToggleButtonProps) {
  const isDark = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);

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

  if (variant === "mobile") {
    return (
      <button
        type="button"
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        onClick={toggleTheme}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-(--ink-muted) hover:bg-(--surface-hover) hover:text-(--ink)"
      >
        {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      onClick={toggleTheme}
      className="-ml-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-(--ink-faint) transition-colors hover:bg-(--surface-hover) hover:text-(--ink)"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
