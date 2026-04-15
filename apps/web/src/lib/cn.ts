/**
 * cn — Tailwind class-name merger.
 *
 * Purpose:  Thin wrapper around clsx + tailwind-merge used by every UI
 *           primitive and page in apps/web. Kept web-local so it can
 *           lean on tailwind-merge without polluting the shared
 *           @lmbr/lib package (which must stay React-Native-safe).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
