/**
 * Input — LMBR.ai design-system primitive.
 *
 * Purpose:  Base text input built to the exact specification in README §5.
 *           Dark surface, accent focus ring, error state, placeholder tone
 *           pulled from the design tokens. Export also includes a Price
 *           variant that switches on tabular monospace and right-alignment
 *           for the comparison matrix and margin stacking screens (see
 *           README rule §14-5 — data is readable first).
 * Inputs:   standard <input> props + error flag + a variant.
 * Outputs:  <input>.
 * Agent/API: none.
 * Imports:  ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

const INPUT_BASE =
  'block w-full h-9 px-3 rounded-sm bg-bg-subtle border border-border-base ' +
  'text-text-primary placeholder:text-text-tertiary ' +
  'text-body font-sans ' +
  'transition-[background-color,border-color,box-shadow] duration-micro ' +
  'focus:outline-none focus:border-accent-primary focus:bg-bg-elevated focus:shadow-accent ' +
  'disabled:opacity-40 disabled:pointer-events-none ' +
  'aria-[invalid=true]:border-semantic-error aria-[invalid=true]:shadow-error';

const PRICE_CLASSES =
  'font-mono tabular-nums text-right';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  variant?: 'text' | 'price';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { className, type = 'text', variant = 'text', error, ...props },
    ref,
  ) {
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={error || undefined}
        className={cn(INPUT_BASE, variant === 'price' && PRICE_CLASSES, className)}
        {...props}
      />
    );
  },
);
