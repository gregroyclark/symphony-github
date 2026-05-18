import { constants, access } from "node:fs/promises";
import path from "node:path";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function hasLabel(labels: string[], label: string): boolean {
  const wanted = normalizeLabel(label);
  return labels.some((candidate) => normalizeLabel(candidate) === wanted);
}

export function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = identifier
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "issue";
}

export function resolvePathFrom(baseDir: string, input: string): string {
  const withHome = input.startsWith("~/")
    ? path.join(process.env.HOME ?? process.cwd(), input.slice(2))
    : input;
  return path.isAbsolute(withHome) ? path.normalize(withHome) : path.resolve(baseDir, withHome);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(input: string, max = 1200): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 3)}...`;
}
