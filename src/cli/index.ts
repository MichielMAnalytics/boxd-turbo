// boxd-ci: CI for Turborepo monorepos on boxd machines.

import { readFileSync } from "node:fs";
import { explain, HELP, parseCli } from "./args.js";
import { doctorCommand } from "./commands/doctor.js";
import { grepCommand, logsCommand, lsCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { secretCommand } from "./commands/secret.js";
import { loadContext } from "./context.js";
import { red, stdout } from "./ui.js";

function version(): string {
  for (const p of ["../package.json", "../../package.json"]) {
    try {
      return (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      // try the next layout (dist/ or src/cli/)
    }
  }
  return "unknown";
}

async function main(argv: string[]): Promise<number> {
  const { command, args, flags } = parseCli(argv);
  if (command === "help") {
    stdout.line(HELP);
    return 0;
  }
  if (command === "version") {
    stdout.line(version());
    return 0;
  }
  const ctx = loadContext(process.cwd(), flags);
  switch (command) {
    case "init":
      return initCommand(ctx, flags, stdout);
    case "run":
      return runCommand(ctx, flags, stdout);
    case "ls":
      return lsCommand(ctx, flags, stdout);
    case "logs":
      return logsCommand(ctx, args, flags, stdout);
    case "grep":
      return grepCommand(ctx, args, flags, stdout);
    case "doctor":
      return doctorCommand(ctx, flags, stdout);
    case "secret":
      return secretCommand(ctx, args, flags, stdout);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    const message = explain(e.message);
    if (process.argv.includes("--json")) stdout.json({ error: message });
    else process.stderr.write(`${red("boxd-ci:")} ${message}\n`);
    process.exit(1);
  },
);
