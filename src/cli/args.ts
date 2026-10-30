// Command line parsing: `boxd-ci <command> [arguments] [--flags]`, strict about what each command takes.

import { parseArgs } from "node:util";

const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const account = { org: str, server: str, json: bool } as const;

const OPTIONS = {
  init: { ...account, "dry-run": bool, "no-github": bool, rebuild: bool },
  run: { ...account, "max-machines": str },
  ls: { ...account, limit: str },
  logs: { ...account, task: str, failed: bool },
  grep: { ...account, runs: str },
  doctor: { ...account, sweep: bool },
} as const;

export type Command = keyof typeof OPTIONS | "help" | "version";
export type Parsed = { command: Command; args: string[]; flags: Record<string, string | boolean> };

const COMMANDS = Object.keys(OPTIONS);

export function parseCli(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h")
    return { command: "help", args: [], flags: {} };
  if (first === "--version" || first === "-v" || first === "version")
    return { command: "version", args: [], flags: {} };
  if (!(first in OPTIONS)) {
    throw new Error(`unknown command ${first}: try ${COMMANDS.slice(0, -1).join(", ")} or ${COMMANDS.at(-1)}`);
  }
  const command = first as keyof typeof OPTIONS;
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help", args: [command], flags: {} };
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: OPTIONS[command],
      allowPositionals: true,
      strict: true,
    });
    return { command, args: positionals, flags: values as Record<string, string | boolean> };
  } catch (e) {
    const unknown = /Unknown option '([^']+)'/.exec((e as Error).message);
    if (unknown) throw new Error(`unknown option ${unknown[1]} for ${command}`);
    throw new Error(`${command}: ${(e as Error).message}`);
  }
}

export const HELP = `boxd-ci: CI for Turborepo monorepos on boxd machines

  boxd-ci run                 CI on your working copy, now: every ci task on its own machine
  boxd-ci init                set up CI for this repository: snapshot, cache, GitHub check on every push
  boxd-ci ls                  the latest runs
  boxd-ci logs [run]          the logs of a run (default: the latest); --task <id>, --failed
  boxd-ci grep <text>         search the logs of recent runs
  boxd-ci doctor              check the setup; --sweep deletes machines a finished run left behind

  --json                      machine-readable output, for scripts and agents
  --org <org>                 the boxd org (default: .boxd-ci.json, then your boxd CLI's active org)
  --server <name>             the boxd-ci server machine (default: boxd-ci-server)

Tasks come from turbo.json: every task tagged "ci", the way Vercel CI reads it.
Sign in once with \`boxd auth login\` (or set BOXD_API_KEY).
https://github.com/azin-tech/boxd-ci`;
