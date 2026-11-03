import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeScope } from "../dist/session.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "dist/cli.js");
const artifacts = path.join(project, ".test-artifacts", `${Date.now()}-${process.pid}`);
let sequence = 0;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function fixture() {
  const root = path.join(artifacts, `repo ${++sequence}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "empty-hooks"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.hooksPath", path.join(root, "empty-hooks"));
  fs.writeFileSync(path.join(root, "src/a.txt"), "initial\n", "utf8");
  fs.writeFileSync(path.join(root, "docs/a.txt"), "docs\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return root;
}

function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stderr || result.stdout}`);
  return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
}

function start(root, id, scope) { return run(root, ["start", id, "--path", scope]); }

function concurrent(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("creates an offline worktree from committed HEAD without changing the source or copying secrets", () => {
  const root = fixture();
  const originalHead = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "src/a.txt"), "unfinished\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "TEST_SECRET=not-for-copying\n", "utf8");
  const session = start(root, "한글-session", "src");
  assert.equal(session.status, "active");
  assert.equal(git(session.worktree, "branch", "--show-current"), "agents/한글-session");
  assert.equal(git(session.worktree, "rev-parse", "HEAD"), originalHead);
  assert.equal(fs.readFileSync(path.join(session.worktree, "src/a.txt"), "utf8"), "initial\n");
  assert.equal(fs.readFileSync(path.join(root, "src/a.txt"), "utf8"), "unfinished\n");
  assert.equal(fs.existsSync(path.join(session.worktree, ".env")), false);
  assert.equal(git(root, "branch", "--show-current"), "main");
});

test("blocks nested and repository-wide claims; rejected start leaves no branch", () => {
  const root = fixture();
  start(root, "one", "src");
  assert.match(run(root, ["start", "two", "--path", "src/sub"], 1), /Scope conflict/u);
  assert.match(run(root, ["start", "all", "--path", "."], 1), /Scope conflict/u);
  assert.equal(git(root, "branch", "--list", "agents/two"), "");
  assert.equal(run(root, ["status"]).length, 1);
});

test("claim adds paths atomically and cannot take another session's scope", () => {
  const root = fixture();
  const one = start(root, "one", "src");
  const two = start(root, "two", "docs");
  assert.match(run(one.worktree, ["claim", "--path", "docs"], 1), /Scope conflict/u);
  assert.deepEqual(run(root, ["status"])[0].paths, ["src"]);
  const updated = run(one.worktree, ["claim", "--path", "new", "--path", "src"]);
  assert.deepEqual(updated.paths, ["new", "src"]);
  assert.equal(run(two.worktree, ["check"]).session, "two");
});

test("check covers untracked, staged, unstaged and both sides of a move", () => {
  const root = fixture();
  const one = start(root, "one", "src");
  assert.match(run(one.worktree, ["check", "--path", "docs/a.txt"], 1), /Outside claimed scope/u);
  fs.writeFileSync(path.join(one.worktree, "new.txt"), "new\n", "utf8");
  assert.match(run(one.worktree, ["check"], 1), /new.txt/u);
  run(one.worktree, ["claim", "--path", "new.txt"]);
  git(one.worktree, "add", "new.txt");
  assert.ok(run(one.worktree, ["check"]).checked.includes("new.txt"));
  fs.writeFileSync(path.join(one.worktree, "docs/a.txt"), "changed\n", "utf8");
  assert.match(run(one.worktree, ["check"], 1), /docs\/a.txt/u);
  run(one.worktree, ["claim", "--path", "docs"]);
  git(one.worktree, "add", ".");
  git(one.worktree, "commit", "-m", "inside claimed scope");
  // A move is represented by deletion + addition, so an unclaimed source is visible.
  const two = start(root, "move", "other");
  fs.mkdirSync(path.join(two.worktree, "other"));
  git(two.worktree, "mv", "src/a.txt", "other/a.txt");
  assert.match(run(two.worktree, ["check"], 1), /src\/a.txt/u);
});

test("release refuses unfinished work and preserves branches, commits and worktrees", () => {
  const root = fixture();
  const one = start(root, "one", "src");
  fs.writeFileSync(path.join(one.worktree, "src/a.txt"), "my work\n", "utf8");
  assert.match(run(root, ["release", "one"], 1), /uncommitted changes/u);
  assert.equal(run(root, ["status"])[0].status, "active");
  git(one.worktree, "add", ".");
  git(one.worktree, "commit", "-m", "keep this work");
  const commit = git(one.worktree, "rev-parse", "HEAD");
  assert.equal(run(root, ["release", "one"]).status, "released");
  assert.equal(git(one.worktree, "rev-parse", "HEAD"), commit);
  assert.equal(fs.readFileSync(path.join(one.worktree, "src/a.txt"), "utf8"), "my work\n");
  assert.match(run(one.worktree, ["check"], 1), /active session worktree/u);
  assert.equal(start(root, "two", "src").status, "active");
});

test("rejects invalid IDs, escaping paths, Git metadata and unknown options", () => {
  const root = fixture();
  for (const scope of ["..", "../outside", ".git/config", "src/../../outside", "C:\\outside", path.parse(root).root]) {
    assert.throws(() => normalizeScope(root, scope), /relative path|leaves the repository/u);
  }
  for (const id of ["../escape", "-option", "a/b", "NUL", "CON"]) {
    assert.match(run(root, ["start", id, "--path", "src"], 1), /Session ID|Unknown option/u);
  }
  assert.match(run(root, ["status", "--path", "src"], 1), /Unknown option/u);
  assert.match(run(root, ["start", "one", "--path"], 1), /argument/u);
  assert.deepEqual(run(root, ["status"]), []);
});

test("rejects symlink/junction aliases that could bypass claims", () => {
  const root = fixture();
  fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => normalizeScope(root, "alias/a.txt"), /Symlink scopes/u);
  assert.throws(() => normalizeScope(root, "alias/new/deep.txt"), /Symlink scopes/u);
});

test("Windows path aliases cannot obtain a second claim on the same files", { skip: process.platform !== "win32" }, () => {
  const root = fixture();
  start(root, "one", "src");
  for (const scope of ["src.", "src ", "src/a.txt:stream", "nested/NUL"]) {
    assert.match(run(root, ["start", "two", "--path", scope], 1), /Windows path alias/u);
  }
  assert.match(run(root, ["start", "two", "--path", "SRC/sub"], 1), /Scope conflict/u);
  assert.equal(run(root, ["status"]).length, 1);
});

test("a damaged registry fails closed and is not overwritten", () => {
  const root = fixture();
  start(root, "one", "src");
  const file = path.join(root, ".git/agent-claims/state.json");
  const damaged = JSON.stringify({ version: 1, sessions: [{ id: "one", paths: ["../escape"] }] });
  fs.writeFileSync(file, damaged, "utf8");
  assert.match(run(root, ["start", "two", "--path", "docs"], 1), /Invalid session/u);
  assert.equal(fs.readFileSync(file, "utf8"), damaged);
});

test("concurrent conflicting starts have exactly one winner", async () => {
  const root = fixture();
  const results = await Promise.all(["one", "two"].map(id => concurrent(root, ["start", id, "--path", "src"])));
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1], JSON.stringify(results));
  assert.match(results.find(r => r.code === 1).stderr, /Scope conflict/u);
  assert.equal(run(root, ["status"]).length, 1);
});

test("concurrent disjoint starts retain both records in the common Git registry", async () => {
  const root = fixture();
  const results = await Promise.all([
    concurrent(root, ["start", "one", "--path", "src"]),
    concurrent(root, ["start", "two", "--path", "docs"]),
  ]);
  assert.deepEqual(results.map(r => r.code), [0, 0], JSON.stringify(results));
  const sessions = run(root, ["status"]);
  assert.equal(sessions.length, 2);
  assert.equal(run(sessions[0].worktree, ["status"]).length, 2);
});

test("failed Git creation keeps a reservation until explicitly released", () => {
  const root = fixture();
  git(root, "branch", "agents"); // A parent ref prevents creation of agents/one.
  assert.match(run(root, ["start", "one", "--path", "src"], 1), /Start incomplete/u);
  assert.equal(run(root, ["status"])[0].status, "starting");
  assert.match(run(root, ["start", "two", "--path", "src"], 1), /Scope conflict/u);
  assert.equal(run(root, ["release", "one"]).status, "released");
  assert.equal(git(root, "branch", "--list", "agents"), "agents");
});

test("released worktrees with a changed branch are not silently accepted", () => {
  const root = fixture();
  const one = start(root, "one", "src");
  git(one.worktree, "switch", "-c", "different");
  assert.match(run(root, ["release", "one"], 1), /identity changed/u);
  assert.equal(run(root, ["status"])[0].status, "active");
});

test("the packed CLI runs in a separate repository without development dependencies", () => {
  assert.ok(process.env.npm_execpath, "Run through npm test so the npm CLI path is available.");
  const packageDir = path.join(artifacts, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  const cache = path.join(artifacts, "npm-cache");
  const npm = (cwd, args) => {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd, encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const [packed] = JSON.parse(npm(project, ["pack", "--ignore-scripts", "--json", "--cache", cache, "--pack-destination", packageDir]));
  assert.deepEqual(packed.files.map(file => file.path).sort(), ["PROVENANCE.md", "README.md", "dist/cli.js", "dist/session.js", "package.json"]);
  const consumer = fixture();
  fs.writeFileSync(path.join(consumer, "package.json"), '{"name":"consumer","version":"1.0.0","private":true}\n', "utf8");
  npm(consumer, ["install", "--offline", "--ignore-scripts", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--cache", cache, path.join(packageDir, packed.filename)]);
  assert.equal(fs.existsSync(path.join(consumer, "node_modules/typescript")), false);
  const installedCli = path.join(consumer, "node_modules/agent-claims/dist/cli.js");
  const result = spawnSync(process.execPath, [installedCli, "start", "packaged", "--path", "src"], {
    cwd: consumer, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "active");
});
