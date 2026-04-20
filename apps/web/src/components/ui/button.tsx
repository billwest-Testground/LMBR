/**
 * Button — LMBR.ai design-system primitive.
 *
 * Purpose:  The single button component used across every LMBR.ai screen.
 *           Implements the five variants from README §5 exactly —
 *           primary (accent), secondary (outline), ghost, destructive,
 *           icon — plus a loading state that replaces the label with
 *           an inline SVG spinner (per README §9's "no raw spinners,
 *           always descriptive" rule when not mid-action, but the inline
 *           spinner is reserved for buttons that are already labeled).
 * Inputs:   variant, size, loading, asChild, any <button> HTML props.
 * Outputs:  <button> or Slot-merged child.
 * Agent/API: none.
 * Imports:  @radix-ui/react-slot, ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../../lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'icon';
type ButtonSize = 'sm' | 'md' | 'lg';

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-sm ' +
  'font-medium transition-[background-color,color,transform,box-shadow] duration-micro ' +
  'focus-visible:outline-none focus-visible:shadow-accent ' +
  'disabled:opacity-40 disabled:pointer-events-none ' +
  'active:scale-[0.98] select-none whitespace-nowrap';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Primary is the one button where teal lives. Text is a literal
  // white (accent-on) in both modes — `text-text-inverse` would flip
  // to cream in light mode, which looks wrong against teal.
  primary:
    'bg-accent-primary text-accent-on ' +
    'hover:bg-accent-secondary active:bg-accent-tertiary',
  secondary:
    'bg-transparent border border-border-strong text-text-primary ' +
    'hover:bg-bg-subtle',
  ghost:
    'bg-transparent text-text-secondary ' +
    'hover:bg-bg-elevated hover:text-text-primary',
  destructive:
    'bg-transparent border text-semantic-error ' +
    'border-[rgba(192,57,43,0.40)] hover:bg-[rgba(192,57,43,0.12)]',
  icon:
    'bg-transparent text-text-secondary rounded-sm ' +
    'hover:bg-bg-elevated hover:text-text-primary',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-body-sm',
  md: 'h-9 px-4 text-body',
  lg: 'h-10 px-5 text-body',
};

const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 w-8 p-0',
  md: 'h-9 w-9 p-0',
  lg: 'h-10 w-10 p-0',
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      asChild = false,
      disabled,
      children,
      type,
      ...props
    },
    ref,
  ) {
    const Component = asChild ? Slot : 'button';
    const isIcon = variant === 'icon';

    return (
      <Component
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        className={cn(
          BASE_CLASSES,
          VARIANT_CLASSES[variant],
          isIcon ? ICON_SIZE_CLASSES[size] : SIZE_CLASSES[size],
          className,
        )}
        {...props}
      >
        {loading ? <InlineSpinner /> : children}
      </Component>
    );
  },
);

function InlineSpinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
