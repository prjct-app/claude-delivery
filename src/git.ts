import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface Repo {
  top: string;
  /** Shared by every worktree of the repository, so a contract follows its branch across T3 worktrees. */
  commonDir: string;
  branch: string;
}

/** The repository and branch at `cwd`, or undefined outside git or on a detached HEAD. */
export function repoAt(cwd: string): Repo | undefined {
  try {
    const [top, commonDir, branch] = git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"]).split("\n");
    if (!top || !commonDir || !branch || branch === "HEAD") return undefined;
    return { top, commonDir: isAbsolute(commonDir) ? commonDir : join(cwd, commonDir), branch };
  } catch {
    return undefined;
  }
}

/** The git dir shared by every worktree of the repository at `cwd`, even on a detached HEAD. */
export function commonDirAt(cwd: string): string | undefined {
  try {
    return resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
  } catch {
    return undefined;
  }
}

/**
 * Hash of the working tree's content, including untracked files that are not ignored.
 * Built in a throwaway index so the real staging area is never touched. Commits do not change it;
 * any edit, by any tool, script or subagent, does.
 */
export function treeOf(top: string): string {
  const dir = mkdtempSync(join(tmpdir(), "delivery-"));
  try {
    const index = join(dir, "index");
    const real = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(real)) {
      copyFileSync(real, index);
      // Git trusts cached stat data for files older than the index. A fresh mtime on the copy would
      // hide same-size edits made within the index's timestamp granularity, so keep the original
      // (millisecond-truncated, which only makes git re-read more).
      const { atime, mtime } = statSync(real);
      utimesSync(index, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(top, ["add", "-A", "--", "."], env);
    return git(top, ["write-tree"], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Paths that differ between two trees; empty if either tree is no longer available. */
export function changedPaths(top: string, from: string, to: string): string[] {
  if (from === to) return [];
  try {
    return git(top, ["diff-tree", "-r", "--name-only", from, to]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function diffStat(top: string, from: string, to: string): string {
  try {
    return git(top, ["diff-tree", "-r", "--stat", from, to]);
  } catch {
    return "";
  }
}

export function headCommit(top: string): string {
  try {
    return git(top, ["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

/** The tree of the commit that a push would send. */
export function headTree(top: string): string {
  try {
    return git(top, ["rev-parse", "HEAD^{tree}"]);
  } catch {
    return "";
  }
}

/** The worktree where `branch` is checked out, if any. */
export function worktreeOf(commonDir: string, branch: string): string | undefined {
  try {
    const listing = execFileSync("git", ["--git-dir", commonDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    for (const block of listing.split("\n\n")) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (path && block.split("\n").includes(`branch refs/heads/${branch}`)) return path;
    }
  } catch {}
  return undefined;
}

export function defaultBranch(top: string): string | undefined {
  try {
    return git(top, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    for (const name of ["main", "master", "develop"]) {
      try {
        git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
        return name;
      } catch {}
    }
    return undefined;
  }
}

export function summarizePaths(paths: string[], limit = 8): string {
  if (paths.length === 0) return "(paths unavailable)";
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}
