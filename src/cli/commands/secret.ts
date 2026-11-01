// boxd-turbo secret: the secrets tasks and installs get. Each is a boxd secret with the unattached
// scope, which reaches only the machines that name it, and its name goes into .boxd-turbo.json, which
// is how boxd-turbo's machines name it. The value never reaches this terminal's output.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { connect } from "../../boxd/sdk.js";
import { CONFIG_FILE, SECRET_NAME } from "../../core/config.js";
import { type Ctx, writeRegularFile } from "../context.js";
import { bold, dim, green, type Out, yellow } from "../ui.js";

type Scope = { scope?: "unattached"; org?: string };

export type SecretDeps = {
  secrets: {
    set(name: string, value: string, p?: Scope): Promise<string>;
    delete(name: string, p?: Scope): Promise<string>;
    list(p?: { org?: string }): Promise<{ name: string; scope: string }[]>;
  };
  /** The value, from stdin when it is piped, else typed with the input hidden. */
  readValue(name: string): Promise<string>;
};

/** .boxd-turbo.json's text with the name in (or out of) its secrets list, comments and all kept. */
export function withSecretName(text: string, name: string, present: boolean): string {
  const current = ((parse(text) as { secrets?: unknown } | undefined)?.secrets ?? []) as unknown[];
  const names = current.filter((n): n is string => typeof n === "string");
  const next = present ? (names.includes(name) ? names : [...names, name]) : names.filter((n) => n !== name);
  if (present && names.includes(name)) return text;
  return applyEdits(text, modify(text, ["secrets"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

export async function secretCommand(
  ctx: Ctx,
  args: string[],
  _flags: Record<string, string | boolean>,
  out: Out,
  deps?: SecretDeps,
): Promise<number> {
  const [action, name] = args;
  const d = deps ?? { secrets: (connect() as unknown as { secrets: SecretDeps["secrets"] }).secrets, readValue };
  const scope: Scope = { scope: "unattached", ...(ctx.org ? { org: ctx.org } : {}) };
  const file = join(ctx.root, CONFIG_FILE);
  const config = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const configured = ctx.config.secrets ?? [];

  if (action === "ls" || action === undefined) {
    const have = new Set((await d.secrets.list(ctx.org ? { org: ctx.org } : {})).map((s) => s.name));
    if (ctx.json) {
      out.json(configured.map((n) => ({ name: n, set: have.has(n) })));
      return 0;
    }
    if (!configured.length) out.line(`no secrets in ${CONFIG_FILE}. ${bold("boxd-turbo secret set NAME")} adds one.`);
    for (const n of configured) out.line(`${n.padEnd(28)} ${have.has(n) ? green("set") : yellow("missing")}`);
    return 0;
  }
  if ((action !== "set" && action !== "rm") || !name) {
    throw new Error("usage: boxd-turbo secret set NAME, boxd-turbo secret rm NAME, or boxd-turbo secret ls");
  }
  if (!SECRET_NAME.test(name)) {
    throw new Error(
      "a secret's name is an environment variable name (letters, digits and _), and BOXD_* is boxd's own",
    );
  }

  if (action === "set") {
    const value = await d.readValue(name);
    if (!value) throw new Error(`no value for ${name}`);
    await d.secrets.set(name, value, scope);
    writeRegularFile(file, withSecretName(config, name, true));
    if (ctx.json) out.json({ name, set: true });
    else {
      out.line(`${green("✓")} ${name} is set in ${ctx.org ?? "your org"}, for boxd-turbo's machines only.`);
      out.line(`  ${CONFIG_FILE} names it. Commit it, since pushes use the default branch's list.`);
      out.line(dim(`  Tasks see it once turbo.json lists it, in a task's "env" or in "globalEnv".`));
    }
    return 0;
  }
  await d.secrets.delete(name, scope);
  writeRegularFile(file, withSecretName(config, name, false));
  if (ctx.json) out.json({ name, set: false });
  else out.line(`${name} is deleted, and ${CONFIG_FILE} no longer names it.`);
  return 0;
}

/** Reads a secret's value: all of stdin when piped, else one line typed with the echo off. */
async function readValue(name: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.replace(/\r?\n$/, "");
  }
  process.stderr.write(`${name} (typing is hidden): `);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (f: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      f();
    };
    const onData = (b: Buffer) => {
      for (const c of b.toString("utf8")) {
        if (c === "\r" || c === "\n") return done(() => resolve(value));
        if (c === "\u0003") return done(() => reject(new Error("cancelled")));
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}
