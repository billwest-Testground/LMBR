/**
 * ThemeToggle — light/dark mode switch.
 *
 * Purpose:  Flips the monochrome light/dark palette by toggling
 *           `data-theme="dark"` on <html>. The CSS variables in
 *           globals.css swap under that attribute; no JS-driven style
 *           rewrites are needed. Preference persists in localStorage
 *           as `lmbr-theme`. The root layout runs a tiny inline
 *           script (see ThemeBootScript below) BEFORE first paint so
 *           users don't see a light-mode flash when they've opted
 *           into dark.
 *
 *           Ghost-style icon button, no label. Sun when current mode
 *           is light (clicking flips to dark), Moon when dark.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';

import { cn } from '../../lib/cn';

const STORAGE_KEY = 'lmbr-theme';
type Theme = 'light' | 'dark';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  // Initialize to light and let the first useEffect sync to the real
  // stored value. This avoids a hydration mismatch — the server
  // always renders the icon for "light" since it can't see
  // localStorage. After mount, we read storage and flip if needed.
  const [theme, setTheme] = React.useState<Theme>('light');
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    setMounted(true);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage can throw in incognito / quota-exceeded cases;
      // the UI still reflects the change in memory.
    }
  }

  const Icon = theme === 'dark' ? Moon : Sun;
  const nextLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      onClick={toggle}
      // Render a neutral icon before mount to match the SSR output.
      // aria-hidden suppresses the screenreader until we know the
      // real state; there's no user-visible jank because the icon
      // itself is the same size regardless.
      aria-label={mounted ? nextLabel : 'Theme toggle'}
      aria-hidden={!mounted || undefined}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-sm',
        'text-text-secondary transition-colors duration-micro',
        'hover:bg-bg-elevated hover:text-text-primary',
        'focus-visible:outline-none focus-visible:shadow-accent',
        className,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/**
 * Inline script that applies the stored theme BEFORE the React tree
 * mounts. Prevents the "flash of wrong theme" that otherwise happens
 * because localStorage is only readable on the client — if we wait
 * for useEffect, the first paint is always light.
 *
 * Rendered as an unminified string via dangerouslySetInnerHTML in the
 * root layout's <head>. The script itself is tiny and runs in <1ms.
 */
export const THEME_BOOT_SCRIPT = `
(function() {
  try {
    var t = localStorage.getItem('${STORAGE_KEY}');
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) { /* ignore */ }
})();
`;
