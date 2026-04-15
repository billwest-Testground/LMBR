/**
 * Tailwind configuration — LMBR.ai web.
 *
 * Purpose:  Materializes the Worklighter/LMBR.ai UI/UX design system from
 *           README.md §13 as Tailwind tokens so every component, screen,
 *           and primitive can reference the same design language. Dark-
 *           first: the console is built against the near-black palette
 *           first and light mode, when it exists, is an inversion layer.
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
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx,js,jsx,mdx}',
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0A0E0C',
          surface: '#111714',
          elevated: '#1A2120',
          subtle: '#1F2A27',
        },
        border: {
          base: '#1E2E29',
          subtle: '#162420',
          strong: '#2A4038',
        },
        accent: {
          primary: '#1DB87A',
          secondary: '#15926A',
          tertiary: '#0F6B4E',
          warm: '#8FD44A',
          warm2: '#C8E86A',
          glow: '#4AE89A',
        },
        text: {
          primary: '#F0EBE0',
          secondary: '#A8B5AF',
          tertiary: '#6B7C75',
          inverse: '#0A0E0C',
        },
        semantic: {
          success: '#1DB87A',
          warning: '#E8A832',
          error: '#E85448',
          info: '#4A9EE8',
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
        sm: '0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
        md: '0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        lg: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        accent: '0 0 0 2px rgba(29, 184, 122, 0.35)',
        warm: '0 0 0 2px rgba(143, 212, 74, 0.30)',
        error: '0 0 0 2px rgba(232, 84, 72, 0.25)',
      },
      backgroundImage: {
        'gradient-brand':
          'linear-gradient(160deg, #C8E86A 0%, #1DB87A 45%, #0B7A5A 100%)',
        'gradient-surface':
          'linear-gradient(180deg, #111714 0%, #0D1210 100%)',
        'gradient-accent':
          'linear-gradient(135deg, rgba(29,184,122,0.12) 0%, rgba(29,184,122,0.03) 100%)',
        'gradient-warm':
          'linear-gradient(135deg, #8FD44A 0%, #E8A832 100%)',
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
