/**
 * Label — LMBR.ai design-system primitive.
 *
 * Purpose:  The UPPERCASE 11px / weight 500 / tracking 0.04em micro label
 *           used above inputs and section dividers per README §5
 *           "Label" spec. Tertiary text color by default; pass `tone`
 *           for callouts.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  tone?: 'default' | 'accent' | 'warn' | 'error';
}

const TONE_CLASSES: Record<NonNullable<LabelProps['tone']>, string> = {
  default: 'text-text-tertiary',
  accent: 'text-accent-primary',
  warn: 'text-semantic-warning',
  error: 'text-semantic-error',
};

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  function Label({ className, tone = 'default', ...props }, ref) {
    return (
      <label
        ref={ref}
        className={cn(
          'mb-1.5 block text-label uppercase',
          TONE_CLASSES[tone],
          className,
        )}
        {...props}
      />
    );
  },
);
