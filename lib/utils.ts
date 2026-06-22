import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names, resolving conflicts (later wins) and
 * dropping falsy values. Framework-free helper used across the UI layer.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
