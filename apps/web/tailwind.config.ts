/**
 * Tailwind configuration — LMBR.ai web.
 *
 * Purpose:  Materializes the monochrome light-first design system from
 *           README.md §1 as Tailwind tokens. Surface / border / text
 *           tokens resolve through CSS variables so the same class
 *           stays correct in both light mode (default) and dark mode
 *           (`data-theme="dark"` on <html>). Worklighter accents are
 *           hardcoded hex — they must NEVER reskin per theme; teal
 *           and warm green are reserved for primary-action,
 *           active-nav, and selected-cell states only.
 * Inputs:   content globs.
 * Outputs:  Tailwind `Config`.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  // Attribute-based toggle: ThemeToggle sets data-theme="dark" on
  // <html>; `:root` carries light values by default. We don't use
  // Tailwind's `dark:` variant because the surface/border/text tokens
  // below are CSS-variable-backed — a single `bg-bg-surface` class is
  // correct in both modes without a `dark:` sibling.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './src/**/*.{ts,tsx,js,jsx,mdx}',
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: 'var(--color-bg-base)',
          surface: 'var(--color-bg-surface)',
          elevated: 'var(--color-bg-elevated)',
          subtle: 'var(--color-bg-subtle)',
          inverse: 'var(--color-bg-inverse)',
        },
        border: {
          base: 'var(--color-border-base)',
          subtle: 'var(--color-border-subtle)',
          strong: 'var(--color-border-strong)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary: 'var(--color-text-tertiary)',
          inverse: 'var(--color-text-inverse)',
        },
        // Worklighter accent — ALWAYS the same values in light + dark.
        // Reserved for: primary buttons, active nav, selected states,
        // input focus ring. Never use on text, borders, or surfaces
        // beyond those narrow roles.
        accent: {
          primary: '#1DB87A',
          secondary: '#15926A',
          tertiary: '#0F6B4E',
          warm: '#8FD44A',
          on: '#FFFFFF',
        },
        // Semantic colors are sparingly used — monochrome-leaning hues
        // from the same brand family. Error is red, info is blue, but
        // the overall palette stays quiet.
        semantic: {
          success: '#1DB87A',
          warning: '#B87A1D',
          error: '#C0392B',
          info: '#2D6FA3',
        },
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'Inter',
          'SF Pro Display',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'JetBrains Mono',
          'SF Mono',
          'Fira Code',
          'Cascadia Code',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // README §2 type scale — [size, lineHeight, { weight, tracking }]
        display: ['48px', { lineHeight: '52px', letterSpacing: '-0.02em', fontWeight: '700' }],
        h1: ['32px', { lineHeight: '38px', letterSpacing: '-0.01em', fontWeight: '600' }],
        h2: ['24px', { lineHeight: '30px', letterSpacing: '-0.01em', fontWeight: '600' }],
        h3: ['18px', { lineHeight: '24px', fontWeight: '600' }],
        h4: ['15px', { lineHeight: '21px', fontWeight: '600' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
        body: ['14px', { lineHeight: '21px' }],
        'body-sm': ['13px', { lineHeight: '19px' }],
        caption: ['12px', { lineHeight: '16px', letterSpacing: '0.01em' }],
        label: ['11px', { lineHeight: '14px', letterSpacing: '0.04em', fontWeight: '500' }],
        mono: ['13px', { lineHeight: '19px' }],
      },
      borderRadius: {
        xs: '4px',
        sm: '6px',
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        pill: '999px',
      },
      boxShadow: {
        // Shadows resolve via CSS variable so dark mode can swap to
        // the near-zero variants defined in globals.css — in dark
        // mode, borders carry the weight instead.
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        accent: 'var(--shadow-accent)',
        error: 'var(--shadow-error)',
      },
      transitionDuration: {
        micro: '100ms',
        standard: '150ms',
        entrance: '200ms',
      },
      transitionTimingFunction: {
        entrance: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '0.2' },
          '50%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.4s ease-in-out infinite',
        shimmer: 'shimmer 1.5s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
