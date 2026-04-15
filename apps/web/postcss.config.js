/**
 * PostCSS configuration for LMBR.ai web.
 *
 * Purpose:  Wires Tailwind + Autoprefixer into the Next.js CSS build so the
 *           LMBR.ai design system compiles across modern browser targets.
 * Inputs:   none (build-time).
 * Outputs:  PostCSS config object.
 * Agent/API: none.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
