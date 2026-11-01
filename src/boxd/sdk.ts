// The boxd SDK as boxd-turbo uses it: the calls it makes, typed narrowly enough for a test to fake, and
// a client that signs in the way the boxd CLI does.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Boxd } from "@boxd-sh/sdk";

export type ExecOutput = { stdout: string; stderr: string; exitCode: number };

/** Isolation and labels, or the same in a spec that also names the secrets the machine gets. */
export type Shape =
  | { isolated?: boolean; labels: Record<string, string> }
  | { spec: { version: 1; isolated: boolean; labels: Record<string, string>; secrets: string[] } };

export type CreateParams =
  | ({ name: string; org?: string; fromSnapshot: string; deleteAfter: number } & Shape)
  | ({
      name: string;
      org?: string;
      config: { vcpu: number; memory: string; autoSuspendTimeout: number };
      deleteAfter?: number;
    } & Shape);

/**
 * An isolated machine with these labels. Secrets go in a spec: the SDK refuses labels or isolation
 * next to one, and a machine only gets an unattached secret its spec names.
 */
export function isolatedShape(labels: Record<string, string>, secrets: string[] = []): Shape {
  return secrets.length
    ? { spec: { version: 1, isolated: true, labels, secrets: [...secrets] } }
    : { isolated: true, labels };
}

export type MachineInfo = {
  id: string;
  name: string;
  status: string;
  access: { domain: string };
  labels?: Record<string, string>;
  createdAt?: Date | null;
  /** When boxd deletes it (its delete-after timer), if ever. */
  deleteAt?: Date | null;
};
export type SnapshotInfo = {
  name: string;
  version: number | null;
  status: string;
  vcpu: number;
  createdAt?: Date | null;
};

/** Every SDK call boxd-turbo makes. `new Boxd()` is one. */
export type BoxdLike = {
  machines: {
    create(p: CreateParams): Promise<{ id: string; name: string }>;
    get(id: string): Promise<MachineInfo>;
    list(p: { org?: string; labels: Record<string, string> }): Promise<MachineInfo[]>;
    waitUntilReady(id: string, p?: { timeout?: number }): Promise<unknown>;
    exec(id: string, p: { command: string[]; env?: Record<string, string>; timeout?: number }): Promise<ExecOutput>;
    resize(id: string, p: { vcpu: number; memory: string }): Promise<unknown>;
    hibernate(id: string): Promise<unknown>;
    setAutoHibernateTimeout(id: string, seconds: number): Promise<unknown>;
    delete(id: string): Promise<void>;
    setDeleteAfter(id: string, seconds: number): Promise<unknown>;
    files: { upload(id: string, path: string, source: Uint8Array): Promise<number> };
    proxies: {
      create(machine: string, name: string, port: number): Promise<unknown>;
      list(machine: string): Promise<{ name: string | null; port: number }[]>;
    };
  };
  snapshots: {
    create(machine: string, name: string): Promise<{ version: number }>;
    get(name: string, p?: { org?: string }): Promise<SnapshotInfo>;
    list(p?: { org?: string }): Promise<SnapshotInfo[]>;
    delete(name: string, p?: { org?: string }): Promise<void>;
  };
};

/** Where the boxd CLI keeps its login (`boxd auth login`). */
export function cliCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform = process.platform,
) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "boxd", "credentials.json");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "boxd", "credentials.json");
}

/**
 * How to sign in: BOXD_API_KEY or BOXD_TOKEN when set (and automatically inside a boxd machine),
 * else the boxd CLI's own login, so `boxd auth login` is all a laptop needs.
 */
export function signIn(env: NodeJS.ProcessEnv = process.env, file = cliCredentialsPath(env)): { token?: string } {
  if (env.BOXD_API_KEY || env.BOXD_TOKEN || !existsSync(file)) return {};
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }).token;
    return typeof token === "string" && token ? { token } : {};
  } catch {
    return {};
  }
}

export function connect(): BoxdLike {
  return new Boxd(signIn());
}
