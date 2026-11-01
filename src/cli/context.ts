// Everything a command needs to know before it touches boxd: the repository, its config, the org,
// and how to reach the server.

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BoxdLike, cliCredentialsPath } from "../boxd/sdk.js";
import { ensureServer, SERVER_ROOT, type ServerInfo } from "../boxd/server.js";
import { machineStore, type Store } from "../boxd/store.js";
import { CONFIG_FILE, type Config, parseConfig } from "../core/config.js";
import { originUrl, parseRemote, repoRoot } from "./git.js";

export type Ctx = {
  root: string;
  repo: string;
  cloneUrl: string;
  config: Config;
  warnings: string[];
  org?: string;
  /** The server named with --server or in .boxd-turbo.json. Without one, the org's only server. */
  serverName?: string;
  json: boolean;
};

/** The org the boxd CLI is switched to (`boxd auth switch`). */
export function cliActiveOrg(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const file = join(dirname(cliCredentialsPath(env)), "context.json");
    const org = (JSON.parse(readFileSync(file, "utf8")) as { active_org?: unknown }).active_org;
    return typeof org === "string" && org ? org : undefined;
  } catch {
    return undefined;
  }
}

export function loadContext(cwd: string, flags: Record<string, string | boolean>): Ctx {
  const root = repoRoot(cwd);
  const { repo, cloneUrl } = parseRemote(originUrl(root));
  const file = join(root, CONFIG_FILE);
  const { config, warnings } = parseConfig(existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const org = (flags.org as string | undefined) ?? config.org ?? process.env.BOXD_ORG ?? cliActiveOrg();
  const server = (flags.server as string | undefined) ?? config.server;
  return {
    root,
    repo,
    cloneUrl,
    config,
    warnings,
    ...(org ? { org } : {}),
    ...(server ? { serverName: server } : {}),
    json: flags.json === true,
  };
}

export async function openServer(
  ctx: Ctx,
  boxd: BoxdLike,
  say: (m: string) => void = () => {},
): Promise<{ server: ServerInfo; store: Store }> {
  const server = await ensureServer(boxd, {
    ...(ctx.org ? { org: ctx.org } : {}),
    ...(ctx.serverName ? { name: ctx.serverName } : {}),
    onProgress: say,
  });
  return { server, store: machineStore(boxd, server.machineId, SERVER_ROOT) };
}

/** A bundle that ships next to the CLI (dist/), or in dist/ when running from the sources. */
export function bundled(name: string): Buffer {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, name), join(here, "..", "..", "dist", name)]) if (existsSync(p)) return readFileSync(p);
  throw new Error(`${name} is missing. Run npm run build.`);
}

/** Where a repository that is not a Turborepo monorepo gets CI on boxd. */
export const CI_RUNNERS_GUIDE = "https://docs.boxd.sh/use-cases/ci-runners";

/** The repository's turbo.json (or turbo.jsonc). A folder without one is not a Turborepo monorepo. */
export function requireTurboJson(root: string): string {
  const file = ["turbo.json", "turbo.jsonc"].map((f) => join(root, f)).find((f) => existsSync(f));
  if (!file) {
    throw new Error(
      `no turbo.json in ${root}. boxd-turbo runs Turborepo monorepos. For any other repository, the CI runners guide sets up CI on boxd: ${CI_RUNNERS_GUIDE}`,
    );
  }
  return file;
}

/**
 * Writes a file of the repository (.boxd-turbo.json) in one step. A symbolic link there, which a
 * branch could commit, is refused, so the write never lands in a file outside the repository.
 */
export function writeRegularFile(file: string, text: string): void {
  if (existsSync(file) && !lstatSync(file).isFile()) {
    throw new Error(`${file} is not a regular file, so boxd-turbo will not write it`);
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
