#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startSession, claimPaths, checkSession, releaseSession, listSessions } from "./session.js";

const help = `agent-claims: exclusive file scopes for parallel Git worktrees

  agent-claims start <id> --path <path>... [--base <ref>]
  agent-claims claim --path <path>...
  agent-claims check [--path <path>...]
  agent-claims release <id>
  agent-claims status

Paths are relative to the repository root. Repeat --path for multiple scopes.
start uses committed HEAD by default; it never fetches, pushes or copies secrets.
claim/check run inside a session worktree. release keeps worktrees and branches.
Output is JSON; errors go to stderr with exit code 1.
`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help);
  } else {
    if (!["start", "claim", "check", "release", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        path: { type: "string", multiple: true, default: [] },
        base: { type: "string" },
      },
    });
    if (command !== "start" && values.base !== undefined) throw new Error(`Unknown option --base for ${command}`);
    if ((command === "status" || command === "release") && values.path.length) throw new Error(`Unknown option --path for ${command}`);
    const needsId = command === "start" || command === "release";
    if (positionals.length !== (needsId ? 1 : 0)) throw new Error(`Invalid arguments for ${command}. Run agent-claims --help.`);
    const id = positionals[0] ?? "";
    const cwd = process.cwd();
    let result: unknown;
    switch (command) {
      case "start": result = startSession(cwd, id, values.path, values.base); break;
      case "claim": result = claimPaths(cwd, values.path); break;
      case "check": result = checkSession(cwd, values.path); break;
      case "release": result = releaseSession(cwd, id); break;
      case "status": result = listSessions(cwd); break;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`agent-claims: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
