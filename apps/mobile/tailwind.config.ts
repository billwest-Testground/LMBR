/**
 * NativeWind / Tailwind config — LMBR.ai mobile.
 *
 * Purpose:  Mirrors the web monochrome light-first design system from
 *           README §1 in a shape NativeWind v4 can consume. Dark mode
 *           is a web-only feature for V1 — mobile uses only the light
 *           palette. Worklighter accents (teal / warm green) are
 *           reserved for primary-action, active-tab, and selected
 *           states, same rule as web.
 *
 *           NativeWind resolves colors at build time, so we can't use
 *           CSS variables the way web does. Token values are literal
 *           hex; keep them in sync with globals.css :root.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { Config } from 'tailwindcss';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativewindPreset = require('nativewind/preset');

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [nativewindPreset],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#F7F3EE',
          surface: '#FFFFFF',
          elevated: '#F0EBE3',
          subtle: '#E8E2DA',
          inverse: '#0F0F0F',
        },
        border: {
          base: '#D4CEC6',
          subtle: '#E2DDD8',
          strong: '#B8B0A6',
        },
        text: {
          primary: '#0F0F0F',
          secondary: '#4A4540',
          tertiary: '#8C8480',
          inverse: '#F7F3EE',
        },
        accent: {
          primary: '#1DB87A',
          secondary: '#15926A',
          tertiary: '#0F6B4E',
          warm: '#8FD44A',
          on: '#FFFFFF',
        },
        semantic: {
          success: '#1DB87A',
          warning: '#B87A1D',
          error: '#C0392B',
          info: '#2D6FA3',
        },
      },
    },
  },
  plugins: [],
};

export default config;
