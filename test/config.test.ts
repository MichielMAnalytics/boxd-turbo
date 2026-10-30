import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/core/config.js";

describe("parseConfig", () => {
  test("no file is the defaults", () => {
    expect(parseConfig(undefined)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    expect(DEFAULT_CONFIG).toEqual({ maxMachines: 32, packSeconds: 10 });
  });

  test("reads the run settings and the account settings, with comments", () => {
    const { config, warnings } = parseConfig(
      '{ // boxd-ci\n "org": "acme", "server": "ci-server", "maxMachines": 8, "packSeconds": 0 }',
    );
    expect(config).toEqual({ org: "acme", server: "ci-server", maxMachines: 8, packSeconds: 0 });
    expect(warnings).toEqual([]);
  });

  test("a value out of range is clamped with a warning, an unknown key is named", () => {
    const { config, warnings } = parseConfig('{ "maxMachines": 500, "packSecs": 3 }');
    expect(config.maxMachines).toBe(256);
    expect(warnings).toEqual([
      ".boxd-ci.json: maxMachines is at most 256, so it is 256",
      ".boxd-ci.json: unknown setting packSecs",
    ]);
  });

  test("a file that is not JSON is a warning and the defaults", () => {
    expect(parseConfig("{ nope")).toEqual({
      config: DEFAULT_CONFIG,
      warnings: [".boxd-ci.json is not valid JSON, so the defaults apply"],
    });
  });

  test("secrets are names of boxd secrets; a name that is not an environment variable is a warning", () => {
    const { config, warnings } = parseConfig('{ "secrets": ["DATABASE_URL", "NPM_TOKEN", "not ok", "BOXD_X", 3] }');
    expect(config.secrets).toEqual(["DATABASE_URL", "NPM_TOKEN"]);
    expect(warnings).toEqual([
      ".boxd-ci.json: secrets must be environment variable names, and not BOXD_*, so not ok is left out",
      ".boxd-ci.json: secrets must be environment variable names, and not BOXD_*, so BOXD_X is left out",
      ".boxd-ci.json: secrets must be environment variable names, and not BOXD_*, so 3 is left out",
    ]);
    expect(parseConfig('{ "secrets": "DATABASE_URL" }').warnings).toEqual([
      ".boxd-ci.json: secrets must be a list of names",
    ]);
  });
});
