import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Repo } from "./git.ts";
import type { Contract } from "./state.ts";

export function deliveryDir(repo: Repo): string {
  return join(repo.commonDir, "delivery");
}

function fileName(branch: string): string {
  return `${branch.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export function contractPath(repo: Repo): string {
  return join(deliveryDir(repo), fileName(repo.branch));
}

/**
 * One marker per open contract, outside any repository. The hook wrapper skips starting Node when
 * this directory is empty, so sessions without contracts pay nothing, whichever repo a command targets.
 */
export function registryDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "claude-delivery", "active");
}

function registryEntry(path: string): string {
  return join(registryDir(), createHash("sha256").update(path).digest("hex").slice(0, 32));
}

/** Drops markers whose contract no longer exists (deleted branch, removed clone). */
export function pruneRegistry(): void {
  const dir = registryDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    try {
      if (!existsSync(readFileSync(entry, "utf8").trim())) rmSync(entry, { force: true });
    } catch {
      rmSync(entry, { force: true });
    }
  }
}

/** Every open contract on this machine, from the registry. Unreadable ones are skipped. */
export function openContracts(): Array<{ path: string; commonDir: string; contract: Contract }> {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    try {
      const path = readFileSync(join(dir, name), "utf8").trim();
      const contract = JSON.parse(readFileSync(path, "utf8")) as Contract;
      return contract?.version === 1 ? [{ path, commonDir: dirname(dirname(path)), contract }] : [];
    } catch {
      return [];
    }
  });
}

export function loadContract(repo: Repo): Contract | undefined {
  const path = contractPath(repo);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Contract;
  if (value?.version !== 1) throw new Error(`Unrecognised contract at ${path}.`);
  return value;
}

function write(repo: Repo, contract: Contract): void {
  const path = contractPath(repo);
  mkdirSync(deliveryDir(repo), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(registryEntry(path), path);
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Serialises read-modify-write across processes: parallel tool calls must not lose updates. */
function withLock<T>(repo: Repo, work: () => T): T {
  mkdirSync(deliveryDir(repo), { recursive: true });
  const lock = `${contractPath(repo)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("The contract is busy in another delivery process; try again.");
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function createStoredContract(repo: Repo, contract: Contract): Contract {
  return withLock(repo, () => {
    if (existsSync(contractPath(repo))) {
      throw new Error(`Branch ${repo.branch} already has a contract. Only the user can replace it (/delivery-reset).`);
    }
    write(repo, contract);
    return contract;
  });
}

/** Applies `change` to the latest stored contract under the lock. */
export function updateContract(repo: Repo, change: (contract: Contract) => Contract): Contract {
  return withLock(repo, () => {
    const current = loadContract(repo);
    if (!current) throw new Error(`No delivery contract on branch ${repo.branch}.`);
    const next = change(current);
    if (next !== current) write(repo, next);
    return next;
  });
}

/** Moves the contract out of the way; history is kept for later reference. */
export function archiveContract(repo: Repo, reason: string): string | undefined {
  return withLock(repo, () => {
    const path = contractPath(repo);
    rmSync(registryEntry(path), { force: true });
    if (!existsSync(path)) return undefined;
    const dir = join(deliveryDir(repo), "archive");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${Date.now()}-${reason}-${fileName(repo.branch)}`);
    renameSync(path, target);
    return target;
  });
}

export function logDir(repo: Repo): string {
  const dir = join(deliveryDir(repo), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}
