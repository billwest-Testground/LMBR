/**
 * NativeWind / Tailwind config — LMBR.ai mobile.
 *
 * Purpose:  Tailwind config for the Expo app, driven by NativeWind. Mirrors
 *           the web app's LMBR brand tokens so styling is consistent across
 *           mobile + web.
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
        lmbr: {
          primary: '#0B5D3B',
          'primary-fg': '#FFFFFF',
          accent: '#C89B3C',
          'accent-fg': '#111111',
          ink: '#111111',
          paper: '#FAFAF7',
          muted: '#6B6B6B',
        },
      },
    },
  },
  plugins: [],
};

export default config;
