import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Full local checks, run by `delivery check` only after approval, and blocked before it. */
  checks: string[];
  /** Where the checks came from. An explicit empty list in the config file means "no checks". */
  origin: "config" | "package.json" | "none";
  /** package.json scripts, so `next build` is recognised as what `pnpm run build` runs. */
  scripts: Record<string, string>;
}

export const CONFIG_PATH = ".claude/delivery.json";

/** One script per role, first match wins: lint, types, tests, build. */
const SCRIPT_ROLES = [
  ["lint"],
  ["typecheck", "type-check", "type:check", "types:check", "check-types", "check:types", "tsc"],
  ["test", "test:unit"],
  ["build"],
];

function packageManager(top: string): string {
  if (existsSync(join(top, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(top, "yarn.lock"))) return "yarn";
  if (existsSync(join(top, "bun.lock")) || existsSync(join(top, "bun.lockb"))) return "bun";
  return "npm";
}

function readScripts(top: string): Record<string, string> {
  const pkg = join(top, "package.json");
  if (!existsSync(pkg)) return {};
  try {
    const scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object") return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function loadConfig(top: string): Config {
  const scripts = readScripts(top);
  const configured = join(top, CONFIG_PATH);
  if (existsSync(configured)) {
    const value = JSON.parse(readFileSync(configured, "utf8")) as { checks?: unknown };
    if (!Array.isArray(value.checks)) throw new Error(`${CONFIG_PATH} needs a "checks" array (it may be empty).`);
    const checks = value.checks.filter((c): c is string => typeof c === "string" && Boolean(c.trim()));
    return { checks, origin: "config", scripts };
  }
  const pm = packageManager(top);
  const checks = SCRIPT_ROLES
    .map((names) => names.find((name) => scripts[name]))
    .filter((name): name is string => Boolean(name))
    .map((name) => `${pm} run ${name}`);
  return { checks, origin: checks.length > 0 ? "package.json" : "none", scripts };
}
