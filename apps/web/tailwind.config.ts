/**
 * Tailwind CSS configuration for LMBR.ai web.
 *
 * Purpose:  Sets up Tailwind for the Next.js 14 app-router tree, wires the
 *           placeholder LMBR brand palette (primary forest green, accent
 *           amber — these will be replaced when the UI/UX design system is
 *           inserted), and includes the workspace source path for component
 *           scanning.
 * Inputs:   content globs.
 * Outputs:  Tailwind `Config`.
 * Agent/API: none.
 * Imports:  tailwindcss type.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx,js,jsx,mdx}',
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        lmbr: {
          // PLACEHOLDER TOKENS — will be replaced when the UI/UX design
          // system is inserted.
          primary: '#0B5D3B',
          'primary-fg': '#FFFFFF',
          accent: '#C89B3C',
          'accent-fg': '#111111',
          ink: '#111111',
          paper: '#FAFAF7',
          muted: '#6B6B6B',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular'],
      },
      borderRadius: {
        lmbr: '0.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
