/**
 * Card — LMBR.ai design-system primitive.
 *
 * Purpose:  Renders the three card shapes from README §5 "Cards and
 *           Panels": Standard (bg-surface + border + sm shadow),
 *           Feature (accent gradient + warm border for active/best),
 *           and Stat (metric display). Also exposes sub-components
 *           (CardHeader, CardTitle, CardDescription, CardContent,
 *           CardFooter) so consumers can compose headers/footers
 *           without duplicating layout classes.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import { cn } from '../../lib/cn';

type CardVariant = 'standard' | 'feature' | 'stat';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  standard:
    'bg-bg-surface border border-border-base rounded-md shadow-sm p-5',
  // Monochrome-first: the `feature` variant used to use a teal gradient
  // plus a teal-tinted border to call out active / best choices. In the
  // monochrome system we earn the same emphasis through a stronger
  // border + elevated surface — color stays reserved for primary
  // buttons, active nav, and selected states.
  feature:
    'bg-bg-elevated border border-border-strong rounded-md shadow-sm p-5',
  stat:
    'bg-bg-surface border border-border-base rounded-md shadow-sm px-5 py-4',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = 'standard', ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(VARIANT_CLASSES[variant], className)}
      {...props}
    />
  );
});

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn('mb-4 flex flex-col gap-1.5', className)}
      {...props}
    />
  );
});

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <h3
      ref={ref}
      className={cn('text-h3 text-text-primary', className)}
      {...props}
    />
  );
});

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn('text-body-sm text-text-secondary', className)}
      {...props}
    />
  );
});

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn(className)} {...props} />;
});

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn('mt-5 flex items-center justify-end gap-2', className)}
      {...props}
    />
  );
});
