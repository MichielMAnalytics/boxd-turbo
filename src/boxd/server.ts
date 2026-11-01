// The server: one machine per boxd org that runs the Turborepo remote cache and keeps boxd-turbo's
// state (repositories, snapshots, runs). It sleeps when idle and wakes on the next request, so a
// cached run still answers in seconds.

import { randomBytes } from "node:crypto";
import cachePackage from "./cache-server/package.json" with { type: "json" };
import cacheLock from "./cache-server/package-lock.json" with { type: "json" };
import type { BoxdLike } from "./sdk.js";
import { machineStore, type Store } from "./store.js";

/** Bumped when the setup script changes, so existing servers are set up again. */
export const SERVER_VERSION = 2;
export const SERVER_ROOT = "/home/boxd/boxd-turbo";
const CACHE_PORT = 3000;
const TOKEN_LINE = "boxd-turbo-token=";

export type ServerInfo = { machineId: string; name: string; cacheUrl: string; token: string };

export type ServerBoxd = {
  machines: Pick<BoxdLike["machines"], "create" | "get" | "list" | "waitUntilReady" | "exec" | "files" | "proxies">;
};

/**
 * Installs the cache as a systemd service (artifacts on disk, kept 14 days) and the state folders.
 * Safe to run again: an existing token is kept, the service restarts on the pinned version. The
 * cache server and every package under it come from the lockfile in src/boxd/cache-server.
 */
export function serverSetupScript(): string {
  const root = SERVER_ROOT;
  const env = `${root}/cache-server/.env`;
  return `set -euo pipefail
umask 077
mkdir -p '${root}/cache-server' '${root}/cache' '${root}/repos' '${root}/runs'
chmod 700 '${root}'
cd '${root}/cache-server'
# package.json and package-lock.json were uploaded first: every package is pinned, and none runs a script.
npm ci --ignore-scripts --no-fund --no-audit --loglevel=error >/dev/null
if [ ! -f '${env}' ]; then
  printf 'TURBO_TOKEN=%s\\nSTORAGE_PROVIDER=local\\nSTORAGE_PATH=${root}/cache\\nSTORAGE_PATH_USE_TMP_FOLDER=false\\nPORT=${CACHE_PORT}\\nLOG_LEVEL=warn\\nBODY_LIMIT=1048576000\\n' "$BOXD_TURBO_CACHE_TOKEN" > '${env}'
fi
sudo tee /etc/systemd/system/boxd-turbo-cache.service >/dev/null <<UNIT
[Unit]
Description=boxd-turbo Turborepo remote cache
After=network.target
[Service]
User=$(id -un)
WorkingDirectory=${root}/cache-server
EnvironmentFile=${env}
ExecStart=$(command -v node) ${root}/cache-server/node_modules/turborepo-remote-cache/dist/cli.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/boxd-turbo-cache-clean.service >/dev/null <<UNIT
[Unit]
Description=Delete Turborepo artifacts nobody used for 14 days
[Service]
Type=oneshot
ExecStart=/usr/bin/find ${root}/cache -type f -atime +14 -delete
UNIT
sudo tee /etc/systemd/system/boxd-turbo-cache-clean.timer >/dev/null <<UNIT
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --quiet boxd-turbo-cache.service boxd-turbo-cache-clean.timer
sudo systemctl restart boxd-turbo-cache.service boxd-turbo-cache-clean.timer
echo "${TOKEN_LINE}$(sed -n 's/^TURBO_TOKEN=//p' '${env}')"`;
}

/** True when the cache answers its status route with this token. */
export async function cacheAnswers(url: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v8/artifacts/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export type EnsureServerOptions = {
  org?: string;
  /** The server's machine name. Without one, the org's only server, or a new one. */
  name?: string;
  health?: (url: string, token: string) => Promise<boolean>;
  healthTimeoutMs?: number;
  onProgress?: (line: string) => void;
};

/** The org's server among the machines labeled as one: the one named, or else the only one. */
export function pickServer<T extends { name: string }>(servers: T[], name?: string): T | undefined {
  if (name) return servers.find((s) => s.name === name);
  if (servers.length > 1) {
    throw new Error(
      `this org has ${servers.length} boxd-turbo servers (${servers.map((s) => s.name).join(", ")}). Pick one with --server, or "server" in .boxd-turbo.json.`,
    );
  }
  return servers[0];
}

/** Machine names are global on boxd (each one is a subdomain), so a new server gets its own. */
export const newServerName = () => `boxd-turbo-${randomBytes(3).toString("hex")}`;

/** Finds the org's server, or starts and sets one up. */
export async function ensureServer(boxd: ServerBoxd, o: EnsureServerOptions = {}): Promise<ServerInfo> {
  const m = boxd.machines;
  const say = o.onProgress ?? (() => {});
  const found = pickServer(
    await m.list({ ...(o.org ? { org: o.org } : {}), labels: { "boxd-turbo": "server" } }),
    o.name,
  );

  let id: string;
  if (found) id = found.id;
  else {
    const name = o.name ?? newServerName();
    say(`starting the boxd-turbo server (${name}): the Turborepo cache and run history`);
    const created = await m
      .create({
        name,
        ...(o.org ? { org: o.org } : {}),
        config: { vcpu: 2, memory: "8G", autoSuspendTimeout: 60 },
        labels: { "boxd-turbo": "server" },
      })
      .catch((e: Error) => {
        throw new Error(`could not start the boxd-turbo server "${name}": ${e.message}`);
      });
    id = created.id;
    await m.waitUntilReady(id, { timeout: 180_000 });
  }

  const store: Store = machineStore(boxd, id, SERVER_ROOT);
  const [text, info] = await Promise.all([store.read("server.json"), m.get(id)]);
  const saved = JSON.parse(text ?? "{}") as Partial<ServerInfo & { version: number }>;
  const cacheUrl = `https://cache.${info.name}.${info.access.domain}`;
  let token = saved.token ?? "";

  if (saved.version !== SERVER_VERSION || !token) {
    say("installing the Turborepo cache on the server");
    await m.exec(id, { command: ["bash", "-c", `mkdir -p ${SERVER_ROOT}/cache-server`] });
    const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
    await m.files.upload(id, `${SERVER_ROOT}/cache-server/package.json`, json(cachePackage));
    await m.files.upload(id, `${SERVER_ROOT}/cache-server/package-lock.json`, json(cacheLock));
    const out = await m.exec(id, {
      command: ["bash", "-c", serverSetupScript()],
      env: { BOXD_TURBO_CACHE_TOKEN: token || randomBytes(24).toString("hex") },
      timeout: 600_000,
    });
    const line = out.stdout.split("\n").find((l) => l.startsWith(TOKEN_LINE));
    if (out.exitCode !== 0 || !line) {
      throw new Error(`setting up the boxd-turbo server failed: ${`${out.stderr}\n${out.stdout}`.trim().slice(-2000)}`);
    }
    token = line.slice(TOKEN_LINE.length).trim();
    if (!(await m.proxies.list(id)).some((p) => p.name === "cache")) await m.proxies.create(id, "cache", CACHE_PORT);
    // The automation reads the org from here: the machines it starts belong to the server's org.
    await store.write(
      "server.json",
      JSON.stringify({ version: SERVER_VERSION, cacheUrl, token, ...(o.org ? { org: o.org } : {}) }),
    );
  }

  const health = o.health ?? cacheAnswers;
  const deadline = Date.now() + (o.healthTimeoutMs ?? 60_000);
  while (!(await health(cacheUrl, token))) {
    if (Date.now() > deadline) throw new Error(`the Turborepo cache at ${cacheUrl} did not answer`);
    await new Promise((r) => setTimeout(r, Math.min(1000, o.healthTimeoutMs ?? 1000)));
  }
  return { machineId: id, name: info.name, cacheUrl, token };
}
