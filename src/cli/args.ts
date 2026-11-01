// Command line parsing: `boxd-turbo <command> [arguments] [--flags]`, strict about what each command takes.

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
  secret: { ...account },
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
    throw new Error(`unknown command ${first}. Try ${COMMANDS.slice(0, -1).join(", ")} or ${COMMANDS.at(-1)}.`);
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

export const HELP = `boxd-turbo: CI for Turborepo monorepos on boxd machines

  boxd-turbo run              CI on your working copy, now
  boxd-turbo init             set up CI for this repository (snapshot, cache, a GitHub check on every push)
  boxd-turbo ls               the latest runs
  boxd-turbo logs [run]       a run's logs, the latest by default (--task <id>, --failed)
  boxd-turbo grep <text>      search the logs of recent runs
  boxd-turbo doctor           check the setup (--sweep deletes machines a finished run left behind)
  boxd-turbo secret set NAME  a secret for tasks and installs, typed hidden or piped in (also rm, ls)

  --json                      machine-readable output, for scripts and agents
  --org <org>                 the boxd org (default: .boxd-turbo.json, then your boxd CLI's active org)
  --server <name>             the boxd-turbo server machine (default: boxd-turbo-server)

CI runs the tasks turbo.json tags "ci", the way Vercel CI reads them, or the usual checks (lint,
type checks, tests) when nothing is tagged.
Sign in once with \`boxd auth login\` (or set BOXD_API_KEY).
https://github.com/azin-tech/boxd-turbo`;

/** An error as a person should read it: the SDK's sign-in errors become how to sign in. */
export function explain(message: string): string {
  if (/no credentials|unauthenticated/i.test(message)) {
    return "you are not signed in to boxd. Run boxd auth login, or set BOXD_API_KEY.";
  }
  return message;
}
