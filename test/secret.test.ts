import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type SecretDeps, secretCommand, withSecretName } from "../src/cli/commands/secret.js";
import type { Ctx } from "../src/cli/context.js";
import type { Out } from "../src/cli/ui.js";

const ctx = (root: string, secrets?: string[]): Ctx =>
  ({
    root,
    repo: "acme/web",
    cloneUrl: "https://github.com/acme/web.git",
    config: { maxMachines: 32, packSeconds: 10, ...(secrets ? { secrets } : {}) },
    warnings: [],
    org: "acme",
    serverName: "boxd-ci-server",
    json: false,
  }) as Ctx;

const capture = () => {
  const lines: string[] = [];
  const out = { line: (s = "") => lines.push(s), json: (v: unknown) => lines.push(JSON.stringify(v)) } as Out;
  return { lines, out };
};

const fake = (existing: string[] = []) => {
  const calls: string[] = [];
  const deps: SecretDeps = {
    secrets: {
      set: async (name, value, p) => {
        calls.push(`set ${name}=${value} ${p?.scope} ${p?.org}`);
        return name;
      },
      delete: async (name, p) => {
        calls.push(`delete ${name} ${p?.scope} ${p?.org}`);
        return name;
      },
      list: async () => existing.map((name) => ({ name, scope: "unattached" })),
    },
    readValue: async () => "s3cret-value",
  };
  return { calls, deps };
};

describe("withSecretName", () => {
  test("adds a name to .boxd-ci.json's secrets once, keeping the rest of the file, and removes it", () => {
    const text = '{\n  // ours\n  "org": "acme"\n}\n';
    const added = withSecretName(text, "NPM_TOKEN", true);
    expect(added).toContain("// ours");
    expect(JSON.parse(added.replace(/\/\/.*$/m, "")).secrets).toEqual(["NPM_TOKEN"]);
    expect(withSecretName(added, "NPM_TOKEN", true)).toBe(added);
    expect(JSON.parse(withSecretName(added, "NPM_TOKEN", false).replace(/\/\/.*$/m, "")).secrets).toEqual([]);
  });
});

describe("boxd-ci secret", () => {
  test("set stores an unattached org secret, names it in .boxd-ci.json, and never prints the value", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-secret-"));
    const { calls, deps } = fake();
    const { lines, out } = capture();
    expect(await secretCommand(ctx(root), ["set", "DATABASE_URL"], {}, out, deps)).toBe(0);
    expect(calls).toEqual(["set DATABASE_URL=s3cret-value unattached acme"]);
    expect(JSON.parse(readFileSync(join(root, ".boxd-ci.json"), "utf8")).secrets).toEqual(["DATABASE_URL"]);
    expect(lines.join("\n")).not.toContain("s3cret-value");
    expect(lines.join("\n")).toContain("turbo.json");
  });

  test("a name that is not an environment variable is refused before anything is stored", async () => {
    const { calls, deps } = fake();
    await expect(
      secretCommand(ctx(mkdtempSync(join(tmpdir(), "s-"))), ["set", "BOXD_X"], {}, capture().out, deps),
    ).rejects.toThrow(
      "a secret's name is an environment variable name (letters, digits and _), and BOXD_* is boxd's own",
    );
    expect(calls).toEqual([]);
  });

  test("ls shows each configured name and whether boxd has it", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-secret-"));
    const { deps } = fake(["NPM_TOKEN"]);
    const { lines, out } = capture();
    await secretCommand(ctx(root, ["NPM_TOKEN", "DATABASE_URL"]), ["ls"], {}, out, deps);
    expect(lines.join("\n")).toMatch(/NPM_TOKEN.*set/);
    expect(lines.join("\n")).toMatch(/DATABASE_URL.*missing/);
  });

  test("rm deletes the secret and takes its name out of .boxd-ci.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-secret-"));
    writeFileSync(join(root, ".boxd-ci.json"), '{ "secrets": ["NPM_TOKEN"] }\n');
    const { calls, deps } = fake(["NPM_TOKEN"]);
    await secretCommand(ctx(root, ["NPM_TOKEN"]), ["rm", "NPM_TOKEN"], {}, capture().out, deps);
    expect(calls).toEqual(["delete NPM_TOKEN unattached acme"]);
    expect(JSON.parse(readFileSync(join(root, ".boxd-ci.json"), "utf8")).secrets).toEqual([]);
  });
});
