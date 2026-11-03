// Derived from six-opening's git-session-manager.mjs; see PROVENANCE.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class ClaimError extends Error {}

type Context = { root: string; main: string; common: string; state: string };
export type Session = {
  id: string;
  branch: string;
  worktree: string;
  paths: string[];
  status: "starting" | "active" | "released";
};
type Registry = { version: 1; sessions: Session[] };

const ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
const compare = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // A hook can export the caller's Git paths. Never apply them to another worktree.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[key];
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000, env,
  });
  if (result.error || result.status !== 0) {
    throw new ClaimError(result.error?.message ?? result.stderr.trim() ?? "Git failed");
  }
  return result.stdout;
}

function context(cwd: string): Context {
  const root = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const common = fs.realpathSync(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  const first = git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
  if (!first?.startsWith("worktree ")) throw new ClaimError("Cannot find the main worktree.");
  const main = fs.realpathSync(first.slice(9));
  return { root, main, common, state: path.join(common, "agent-claims") };
}

function worktreePath(ctx: Context, id: string): string {
  return path.join(path.dirname(ctx.main), `${path.basename(ctx.main)}-sessions`, id);
}

/** Scopes are repository-relative. Symlink aliases would defeat exclusive claims. */
export function normalizeScope(root: string, input: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input) || /^[A-Za-z]:/u.test(input) || input.startsWith("\\")) {
    throw new ClaimError(`Use a relative path inside the repository: ${input}`);
  }
  if (process.platform !== "win32" && input.includes("\\")) {
    throw new ClaimError("Use forward slashes in scope paths.");
  }
  if (process.platform === "win32" && input.split(/[\\/]/u).some(part => part !== "." && part !== ".." &&
    (/[<>:"|?*\x00-\x1f]|[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)))) {
    throw new ClaimError(`Unsupported Windows path alias or device name: ${input}`);
  }
  const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join("/") || ".";
  if (relative === ".." || relative.startsWith("../") || relative.split("/").some(p => p.toLowerCase() === ".git")) {
    throw new ClaimError(`Path leaves the repository or points into Git metadata: ${input}`);
  }
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new ClaimError(`Symlink scopes are unsupported: ${input}`);
      current = fs.realpathSync(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return path.relative(root, current).split(path.sep).join("/") || ".";
}

export function contains(scope: string, file: string): boolean {
  const a = compare(scope);
  const b = compare(file);
  return a === "." || a === b || b.startsWith(`${a}/`);
}

function paths(ctx: Context, inputs: string[]): string[] {
  if (!inputs.length) throw new ClaimError("Provide at least one --path.");
  return [...new Set(inputs.map(input => normalizeScope(ctx.root, input)))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRegistry(ctx: Context): Registry {
  const file = path.join(ctx.state, "state.json");
  if (!fs.existsSync(file)) return { version: 1, sessions: [] };
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new ClaimError(`Unsupported or damaged registry: ${file}`);
  }
  const ids = new Set<string>();
  const sessions: Session[] = parsed.sessions.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id) || ids.has(compare(item.id)) ||
      item.branch !== `agents/${item.id}` || typeof item.worktree !== "string" ||
      compare(item.worktree) !== compare(worktreePath(ctx, item.id)) ||
      !Array.isArray(item.paths) || !item.paths.length ||
      !item.paths.every((p: unknown) => typeof p === "string" && normalizeScope(ctx.main, p) === p) ||
      (item.status !== "starting" && item.status !== "active" && item.status !== "released")) {
      throw new ClaimError(`Invalid session record: ${file}`);
    }
    ids.add(compare(item.id));
    return { id: item.id, branch: `agents/${item.id}`, worktree: item.worktree,
      paths: item.paths as string[], status: item.status };
  });
  return { version: 1, sessions };
}

function writeRegistry(ctx: Context, registry: Registry): void {
  const temporary = path.join(ctx.state, `state-${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, path.join(ctx.state, "state.json"));
}

function locked<T>(ctx: Context, action: () => T): T {
  fs.mkdirSync(ctx.state, { recursive: true });
  if (fs.lstatSync(ctx.state).isSymbolicLink()) throw new ClaimError("State directory must not be a symlink.");
  const lock = path.join(ctx.state, "lock");
  let descriptor: number | undefined;
  const deadline = Date.now() + 5_000;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lock, "wx");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new ClaimError(`Registry locked: ${lock}. Check running commands before recovering a stale lock.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

function assertNoConflicts(registry: Registry, scopes: string[], id: string): void {
  for (const session of registry.sessions) {
    if (compare(session.id) === compare(id) || session.status === "released") continue;
    const overlap = scopes.find(scope => session.paths.some(other => contains(scope, other) || contains(other, scope)));
    if (overlap) throw new ClaimError(`Scope conflict with ${session.id}: ${overlap}`);
  }
}

function currentSession(ctx: Context, registry: Registry): Session {
  const branch = git(ctx.root, ["branch", "--show-current"]).trim();
  const session = registry.sessions.find(s => s.status === "active" && s.branch === branch &&
    compare(s.worktree) === compare(ctx.root));
  if (!session) throw new ClaimError("Run this command in an active session worktree.");
  return session;
}

export function startSession(cwd: string, id: string, inputs: string[], base = "HEAD"): Session {
  if (!ID.test(id) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id)) {
    throw new ClaimError("Session ID must be 1-64 letters, digits, underscores or hyphens; reserved device names are unsupported.");
  }
  const ctx = context(cwd);
  const scopes = paths(ctx, inputs);
  return locked(ctx, () => {
    const registry = readRegistry(ctx);
    if (registry.sessions.some(s => compare(s.id) === compare(id))) throw new ClaimError(`Session ID already used: ${id}`);
    const session: Session = { id, branch: `agents/${id}`, worktree: worktreePath(ctx, id), paths: scopes, status: "starting" };
    assertNoConflicts(registry, scopes, id);
    const commit = git(ctx.root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
    if (fs.existsSync(session.worktree)) throw new ClaimError(`Worktree path already exists: ${session.worktree}`);
    const branches = git(ctx.root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n");
    if (branches.some(b => compare(b) === compare(`refs/heads/${session.branch}`))) throw new ClaimError(`Branch already exists: ${session.branch}`);
    registry.sessions.push(session);
    // Reserve first: a crash must keep the scope blocked, not silently available.
    writeRegistry(ctx, registry);
    try {
      fs.mkdirSync(path.dirname(session.worktree), { recursive: true });
      git(ctx.root, ["worktree", "add", "-b", session.branch, session.worktree, commit]);
      session.status = "active";
      writeRegistry(ctx, registry);
    } catch (error) {
      throw new ClaimError(`Start incomplete for ${id}; scope remains reserved. Inspect status, then release ${id} after checking its worktree. ${error instanceof Error ? error.message : String(error)}`);
    }
    return session;
  });
}

export function claimPaths(cwd: string, inputs: string[]): Session {
  const ctx = context(cwd);
  const scopes = paths(ctx, inputs);
  return locked(ctx, () => {
    const registry = readRegistry(ctx);
    const session = currentSession(ctx, registry);
    const combined = [...new Set([...session.paths, ...scopes])].sort();
    assertNoConflicts(registry, combined, session.id);
    session.paths = combined;
    writeRegistry(ctx, registry);
    return session;
  });
}

export function checkSession(cwd: string, proposed: string[] = []): { session: string; checked: string[] } {
  const ctx = context(cwd);
  return locked(ctx, () => {
    const registry = readRegistry(ctx);
    const session = currentSession(ctx, registry);
    assertNoConflicts(registry, session.paths, session.id);
    // Disable rename detection so both the old and new path must be claimed.
    const changed = [...git(ctx.root, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]).split("\0"),
      ...git(ctx.root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")].filter(Boolean);
    const checked = [...new Set([...changed, ...proposed].map(file => normalizeScope(ctx.root, file)))].sort();
    const outside = checked.filter(file => !session.paths.some(scope => contains(scope, file)));
    if (outside.length) throw new ClaimError(`Outside claimed scope: ${outside.join(", ")}`);
    return { session: session.id, checked };
  });
}

export function releaseSession(cwd: string, id: string): Session {
  const ctx = context(cwd);
  return locked(ctx, () => {
    const registry = readRegistry(ctx);
    const session = registry.sessions.find(s => s.id === id);
    if (!session) throw new ClaimError(`Unknown session: ${id}`);
    if (fs.existsSync(session.worktree)) {
      const actual = context(session.worktree);
      if (compare(actual.root) !== compare(session.worktree) || compare(actual.common) !== compare(ctx.common) ||
        git(actual.root, ["branch", "--show-current"]).trim() !== session.branch) {
        throw new ClaimError("Worktree identity changed; inspect it before releasing.");
      }
      if (git(actual.root, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
        throw new ClaimError(`Worktree has uncommitted changes: ${session.worktree}. Commit or preserve them before release.`);
      }
    } else if (session.status === "active") {
      throw new ClaimError("Active worktree is missing; inspect Git worktree metadata before recovery.");
    }
    session.status = "released";
    writeRegistry(ctx, registry);
    return session;
  });
}

export function listSessions(cwd: string): Session[] {
  const ctx = context(cwd);
  return locked(ctx, () => readRegistry(ctx).sessions);
}
