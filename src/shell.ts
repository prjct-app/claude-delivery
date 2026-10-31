// Classifies Bash commands for the gate. Heuristics only decide what to *block*; what counts as a
// change is decided by the tree hash, never by parsing commands.
import { resolve } from "node:path";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const WRAPPERS = new Set(["time", "env", "nice", "nohup", "command", "exec", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Package-manager options that take a value, so the value is not mistaken for the script name. */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  npm: new Set(["-w", "--workspace", "--prefix", "-C"]),
  pnpm: new Set(["-F", "--filter", "-C", "--dir", "--workspace"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--filter", "-F"]),
};

/** Words of one line, unquoted, split into simple commands on control operators outside quotes. */
function lex(command: string): string[][] {
  const result: string[][] = [];
  const state = { words: [] as string[], word: "", inWord: false, quote: undefined as string | undefined };
  const endWord = () => {
    if (state.inWord) state.words.push(state.word);
    state.word = "";
    state.inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (state.words.length > 0) result.push(state.words);
    state.words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (state.quote) {
      if (char === state.quote) state.quote = undefined;
      else if (char === "\\" && state.quote === '"' && next !== undefined) state.word += command[++index];
      else state.word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      state.quote = char;
      state.inWord = true;
    } else if (char === "\\" && next !== undefined) {
      if (next !== "\n") state.word += next;
      state.inWord = next !== "\n" || state.inWord;
      index++;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === "\n" || char === ";" || char === "(" || char === ")" || char === "`" || char === "{" || char === "}") {
      endCommand();
    } else if (char === "$" && next === "(") {
      endCommand();
      index++;
    } else if (char === "&" && (state.word.endsWith(">") || next === ">")) {
      state.word += char; // 2>&1, &>file
      state.inWord = true;
    } else if (char === "&" || char === "|") {
      endCommand();
      if (next === char) index++;
    } else {
      state.word += char;
      state.inWord = true;
    }
  }
  endCommand();
  return result;
}

/** Drops `2>&1`, `>out.log`, `> out.log`, `<in`: they do not change what a command runs. */
function withoutRedirections(tokens: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (/^(\d*|&)(>>?|<)$/.test(token)) index++;
    else if (!/^(\d*|&)(>>?|<)/.test(token)) kept.push(token);
  }
  return kept;
}

function withoutPrefixes(tokens: string[]): string[] {
  const rest = [...tokens];
  while (rest.length > 0) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || WRAPPERS.has(rest[0])) rest.shift();
    else if (rest[0] === "timeout") {
      rest.shift();
      while (rest[0]?.startsWith("-")) {
        const option = rest.shift()!;
        if (["-s", "-k", "--signal", "--kill-after"].includes(option)) rest.shift();
      }
      rest.shift();
    } else break;
  }
  return rest;
}

/** Simple commands of a shell line, with `sh -c '…'` bodies expanded in place. */
export function segments(command: string, depth = 0): string[][] {
  return lex(command).flatMap((raw) => {
    const tokens = withoutPrefixes(withoutRedirections(raw));
    if (tokens.length === 0) return [];
    const flag = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(token));
    if (SHELLS.has(tokens[0]) && flag > 0 && tokens[flag + 1] !== undefined && depth < 3) {
      return segments(tokens[flag + 1], depth + 1);
    }
    return [tokens];
  });
}

/** Each simple command with the directory it runs in, following `cd`, `pushd` and `git -C`. */
export function located(command: string, cwd: string): Array<{ tokens: string[]; dir: string }> {
  const state = { dir: cwd };
  return segments(command).map((tokens) => {
    if ((tokens[0] === "cd" || tokens[0] === "pushd") && tokens[1] && !tokens[1].startsWith("-")) {
      state.dir = resolve(state.dir, tokens[1].replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    }
    const gitDir = tokens[0] === "git" ? tokens.findIndex((t, i) => t === "-C" && i < tokens.length - 1) : -1;
    return { tokens, dir: gitDir > 0 ? resolve(state.dir, tokens[gitDir + 1]) : state.dir };
  });
}

function positionals(tokens: string[]): string[] {
  return tokens.filter((token) => !token.startsWith("-"));
}

/** Words that select a mode rather than a target: `vitest run`, `turbo run build`. */
const MODE_WORDS = new Set(["run"]);

/**
 * Comparable keys for a whole-project check, or none for a targeted run. A run counts as
 * whole-project when it names no targets: `pnpm test`, `pnpm --filter web test --coverage` and
 * `npx vitest run` are; `pnpm test src/a.test.ts` and `vitest run src/a.test.ts` are not.
 * `pnpm vitest` may run a script or a binary, so it yields a key for each reading.
 */
export function checkKeysOf(tokens: string[]): string[] {
  const [head, ...rest] = tokens;
  if (!head) return [];
  if (head === "npx" || head === "bunx" || head === "pnpx") {
    const index = rest.findIndex((token) => !token.startsWith("-"));
    return index < 0 ? [] : checkKeysOf(rest.slice(index));
  }
  if (PACKAGE_MANAGERS.has(head)) {
    const valueOptions = VALUE_OPTIONS[head] ?? new Set<string>();
    const args = [...rest];
    while (args[0]?.startsWith("-")) {
      const option = args.shift()!;
      if (valueOptions.has(option)) args.shift();
    }
    const [first, ...after] = args;
    if (!first) return [];
    if (first === "exec" || first === "dlx" || (head === "npm" && first === "x")) return checkKeysOf(after);
    const isRun = first === "run" || first === "run-script";
    const name = isRun ? after.find((token) => !token.startsWith("-")) : first;
    if (!name) return [];
    const keys: string[] = [];
    const tail = isRun ? after.slice(after.indexOf(name) + 1) : after;
    const npmScript = head !== "npm" || isRun || ["test", "t", "tst"].includes(name);
    if (npmScript && positionals(tail.filter((token) => token !== "--")).length === 0) {
      keys.push(`script:${["t", "tst"].includes(name) ? "test" : name}`);
    }
    // pnpm, yarn and bun run a binary when no script has that name.
    if (head !== "npm" && !isRun) keys.push(...checkKeysOf(args));
    return keys;
  }
  return [`cmd:${positionals(tokens).filter((token, index) => index === 0 || !MODE_WORDS.has(token)).join(" ")}`];
}

/** Keys the configured checks stand for, including the commands their package.json scripts run. */
export function checkKeys(checks: string[], scripts: Record<string, string> = {}): Map<string, string> {
  const keys = new Map<string, string>();
  const expand = (command: string, check: string, depth: number) => {
    for (const tokens of segments(command)) {
      // Housekeeping inside a script body (`rm -rf dist && tsc`) is not a check of its own.
      if (depth > 0 && TRIVIAL.has(tokens[0])) continue;
      for (const key of checkKeysOf(tokens)) {
        if (keys.has(key)) continue;
        keys.set(key, check);
        const script = key.startsWith("script:") ? scripts[key.slice(7)] : undefined;
        if (script && depth < 3) expand(script, check, depth + 1);
      }
    }
  };
  for (const check of checks) expand(check, check, 0);
  return keys;
}

const TRIVIAL = new Set(["echo", "printf", "true", "false", "cd", "rm", "rimraf", "mkdir", "cp", "mv", "touch", "cat", "exit", "export", "set"]);

export function matchesFullCheck(command: string, checks: string[], scripts: Record<string, string> = {}): string | undefined {
  const keys = checkKeys(checks, scripts);
  for (const tokens of segments(command)) {
    const check = fullCheckOf(tokens, keys);
    if (check) return check;
  }
  return undefined;
}

export function fullCheckOf(tokens: string[], keys: Map<string, string>): string | undefined {
  for (const key of checkKeysOf(tokens)) {
    const check = keys.get(key);
    if (check) return check;
  }
  return undefined;
}

export type PublishAction = "pr-create" | "push" | "pr-merge";

export function publishOf(tokens: string[]): PublishAction | undefined {
  const [head, sub, verb] = tokens;
  if (head === "gh" && sub === "pr" && verb === "create") return "pr-create";
  if (head === "gh" && sub === "pr" && verb === "merge") return "pr-merge";
  if (head === "git") {
    const args = tokens.slice(1);
    while (args[0] === "-C" || args[0] === "-c") args.splice(0, 2);
    while (args[0]?.startsWith("-")) args.shift();
    if (args[0] === "push") return "push";
  }
  return undefined;
}

export function publishAction(command: string): PublishAction | undefined {
  for (const tokens of segments(command)) {
    const action = publishOf(tokens);
    if (action) return action;
  }
  return undefined;
}

/** The contract store is the user's record; the agent goes through the CLI. */
export function touchesStore(text: string): boolean {
  return /\.git\/(?:[^\s/]+\/)*delivery\b|claude-delivery\/(?:active|judged)/.test(text);
}

const WRITES = /(^|[^<>&0-9])>{1,2}(?!&)|\b(tee|mv|cp|rm|truncate|install|ln)\b|\bsed\b[^\n]*\s-i|\bperl\b[^\n]*\s-p?i|\bjq\b[^\n]*>/;

export function writesFile(command: string, path: string): boolean {
  return command.includes(path) && WRITES.test(command);
}

/** A prompt that the prompt hook would take as the user's verdict: it starts with the command. */
export const USER_COMMAND = /^\s*\/(?:delivery:)?(?:approve|changes|delivery-reset|delivery-skip)(?=$|\s)/;
/** The same commands anywhere in a shell line, e.g. `echo /approve | claude -p`. */
export const USER_COMMAND_ANYWHERE = /(?:^|[\s"'`(])\/(?:delivery:)?(?:approve|changes|delivery-reset|delivery-skip)(?=$|[\s"'`)])/m;
