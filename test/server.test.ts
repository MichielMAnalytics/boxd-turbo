import { describe, expect, test } from "vitest";
import type { CreateParams, ExecOutput, MachineInfo } from "../src/boxd/sdk.js";
import { ensureServer, SERVER_VERSION, type ServerBoxd, serverSetupScript } from "../src/boxd/server.js";

class FakeBoxd implements ServerBoxd {
  log: string[] = [];
  created?: CreateParams;
  servers: MachineInfo[] = [];
  files = new Map<string, string>();
  setupEnv?: Record<string, string>;
  proxies: { name: string | null; port: number }[] = [];
  machines = {
    create: async (p: CreateParams) => {
      this.created = p;
      this.log.push(`create ${p.name}`);
      return { id: "srv1", name: p.name };
    },
    get: async (id: string): Promise<MachineInfo> => ({
      id,
      name: this.servers.find((x) => x.id === id)?.name ?? this.created?.name ?? "boxd-turbo-server",
      status: "running",
      access: { domain: "boxd.sh" },
    }),
    list: async (p: { labels: Record<string, string> }) => {
      this.log.push(`list ${JSON.stringify(p.labels)}`);
      return this.servers;
    },
    waitUntilReady: async () => {},
    exec: async (_id: string, p: { command: string[]; env?: Record<string, string> }): Promise<ExecOutput> => {
      const script = p.command[2] ?? "";
      if (script.includes("npm ci --ignore-scripts")) {
        this.log.push("setup");
        this.setupEnv = p.env;
        return {
          stdout: `installed\nboxd-turbo-token=${p.env?.BOXD_TURBO_CACHE_TOKEN ?? "kept-token"}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      const cat = /cat '([^']+)'/.exec(script);
      if (cat) {
        const f = this.files.get(cat[1] as string);
        return f === undefined ? { stdout: "", stderr: "", exitCode: 3 } : { stdout: f, stderr: "", exitCode: 0 };
      }
      const mv = /mv -f '([^']+)' '([^']+)'/.exec(script);
      if (mv) this.files.set(mv[2] as string, this.files.get(mv[1] as string) ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    files: {
      upload: async (_id: string, path: string, source: Uint8Array) => {
        this.files.set(path, new TextDecoder().decode(source));
        return source.length;
      },
    },
    proxies: {
      create: async (_m: string, name: string, port: number) => {
        this.log.push(`proxy ${name} ${port}`);
        this.proxies.push({ name, port });
      },
      list: async () => this.proxies,
    },
  };
}

const healthy = async () => true;

describe("serverSetupScript", () => {
  const s = serverSetupScript();
  test("installs the cache server from its lockfile, with no install scripts, and keeps its artifacts on disk", () => {
    expect(s).toContain("npm ci --ignore-scripts");
    expect(s).not.toContain("npm install");
    expect(s).toContain("STORAGE_PATH_USE_TMP_FOLDER=false");
    expect(s).toContain("STORAGE_PATH=/home/boxd/boxd-turbo/cache");
  });
  test("takes the token from the environment and never replaces an existing one", () => {
    expect(s).toContain('"$BOXD_TURBO_CACHE_TOKEN"');
    expect(s).toMatch(/if \[ ! -f [^\]]+\.env' \]; then/);
  });
  test("runs the service with an absolute node path", () => {
    expect(s).toContain("ExecStart=$(command -v node) ");
  });
});

describe("ensureServer", () => {
  test("with no server, starts one with the cache, its proxy and a fresh 48-character token", async () => {
    const boxd = new FakeBoxd();
    const s = await ensureServer(boxd, { org: "acme", name: "boxd-turbo-server", health: healthy });
    expect(boxd.created).toMatchObject({
      name: "boxd-turbo-server",
      org: "acme",
      config: { vcpu: 2, memory: "8G", autoSuspendTimeout: 60 },
      labels: { "boxd-turbo": "server" },
    });
    expect(boxd.setupEnv?.BOXD_TURBO_CACHE_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(boxd.log).toContain("proxy cache 3000");
    expect(s).toEqual({
      machineId: "srv1",
      name: "boxd-turbo-server",
      cacheUrl: "https://cache.boxd-turbo-server.boxd.sh",
      token: boxd.setupEnv?.BOXD_TURBO_CACHE_TOKEN,
    });
    const saved = JSON.parse(boxd.files.get("/home/boxd/boxd-turbo/server.json") ?? "{}");
    expect(saved).toEqual({ version: SERVER_VERSION, cacheUrl: s.cacheUrl, token: s.token, org: "acme" });
    // Every package the cache server runs is pinned by the lockfile that ships with boxd-turbo.
    const lock = JSON.parse(boxd.files.get("/home/boxd/boxd-turbo/cache-server/package-lock.json") ?? "{}");
    expect(lock.packages?.["node_modules/turborepo-remote-cache"]?.version).toBe("2.14.5");
    expect(JSON.parse(boxd.files.get("/home/boxd/boxd-turbo/cache-server/package.json") ?? "{}").dependencies).toEqual({
      "turborepo-remote-cache": "2.14.5",
    });
  });

  test("with no name and no server, starts one under a name of its own, since machine names are global", async () => {
    const boxd = new FakeBoxd();
    const s = await ensureServer(boxd, { org: "acme", health: healthy });
    expect(boxd.created?.name).toMatch(/^boxd-turbo-[0-9a-f]{6}$/);
    expect(s.name).toBe(boxd.created?.name);
    expect(s.cacheUrl).toBe(`https://cache.${s.name}.boxd.sh`);
  });

  test("with no name, the org's server is the one machine labeled as it, whatever it is called", async () => {
    const boxd = new FakeBoxd();
    boxd.servers = [{ id: "s1", name: "boxd-turbo-1a2b3c", status: "running", access: { domain: "boxd.sh" } }];
    const s = await ensureServer(boxd, { org: "acme", health: healthy });
    expect(boxd.created).toBeUndefined();
    expect(s.machineId).toBe("s1");
    expect(s.name).toBe("boxd-turbo-1a2b3c");
  });

  test("with no name and two servers in the org, asks which one", async () => {
    const boxd = new FakeBoxd();
    boxd.servers = ["boxd-turbo-1a2b3c", "boxd-turbo-4d5e6f"].map((name, i) => ({
      id: `s${i}`,
      name,
      status: "running" as const,
      access: { domain: "boxd.sh" },
    }));
    await expect(ensureServer(boxd, { org: "acme", health: healthy })).rejects.toThrow(
      /boxd-turbo-1a2b3c, boxd-turbo-4d5e6f.*--server/,
    );
    expect(boxd.created).toBeUndefined();
  });

  test("an up-to-date server is reused as it is", async () => {
    const boxd = new FakeBoxd();
    boxd.servers = [{ id: "old", name: "boxd-turbo-server", status: "standby", access: { domain: "boxd.sh" } }];
    boxd.files.set(
      "/home/boxd/boxd-turbo/server.json",
      JSON.stringify({
        version: SERVER_VERSION,
        cacheUrl: "https://cache.boxd-turbo-server.boxd.sh",
        token: "t".repeat(48),
      }),
    );
    const s = await ensureServer(boxd, { org: "acme", name: "boxd-turbo-server", health: healthy });
    expect(s).toMatchObject({ machineId: "old", token: "t".repeat(48) });
    expect(boxd.log).not.toContain("setup");
    expect(boxd.log.some((l) => l.startsWith("create"))).toBe(false);
  });

  test("an older server is set up again and keeps its token", async () => {
    const boxd = new FakeBoxd();
    boxd.servers = [{ id: "old", name: "boxd-turbo-server", status: "running", access: { domain: "boxd.sh" } }];
    boxd.proxies = [{ name: "cache", port: 3000 }];
    boxd.files.set("/home/boxd/boxd-turbo/server.json", JSON.stringify({ version: 0, token: "k".repeat(48) }));
    const s = await ensureServer(boxd, { org: "acme", name: "boxd-turbo-server", health: healthy });
    expect(boxd.log).toContain("setup");
    expect(boxd.setupEnv?.BOXD_TURBO_CACHE_TOKEN).toBe("k".repeat(48));
    expect(boxd.log).not.toContain("proxy cache 3000");
    expect(s.token).toBe("k".repeat(48));
  });

  test("a cache that never answers is an error that names the URL", async () => {
    const boxd = new FakeBoxd();
    await expect(
      ensureServer(boxd, { org: "acme", name: "boxd-turbo-server", health: async () => false, healthTimeoutMs: 10 }),
    ).rejects.toThrow("the Turborepo cache at https://cache.boxd-turbo-server.boxd.sh did not answer");
  });
});
