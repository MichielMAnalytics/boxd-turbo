// .boxd-ci.json, in the repository root: optional, and every setting has a default.
//
//   { "org": "acme", "server": "boxd-ci-server", "maxMachines": 32, "packSeconds": 10 }
//
// org and server say where the laptop CLI finds the account's boxd-ci server. maxMachines and
// packSeconds shape a run; the planner reads them at the commit it plans, so they change with code.

import { type ParseError, parse } from "jsonc-parser";

export type Config = {
  /** The boxd org that runs CI. Default: the boxd CLI's active org. */
  org?: string;
  /** The server machine's name. Default: boxd-ci-server. */
  server?: string;
  /** Machines one run may use at once. */
  maxMachines: number;
  /** Tasks that took less than this many seconds last time share a machine (0: never). */
  packSeconds: number;
};

export const DEFAULT_CONFIG: Config = { maxMachines: 32, packSeconds: 10 };
export const CONFIG_FILE = ".boxd-ci.json";

const RANGES = { maxMachines: [1, 256], packSeconds: [0, 600] } as const;

export function parseConfig(text: string | undefined): { config: Config; warnings: string[] } {
  if (text === undefined) return { config: { ...DEFAULT_CONFIG }, warnings: [] };
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: { ...DEFAULT_CONFIG }, warnings: [`${CONFIG_FILE} is not valid JSON, so the defaults apply`] };
  }
  const config: Config = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") continue;
    if (key === "org" || key === "server") {
      if (typeof value === "string" && value) config[key] = value;
      else warnings.push(`${CONFIG_FILE}: ${key} must be a name`);
    } else if (key === "maxMachines" || key === "packSeconds") {
      const [min, max] = RANGES[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        warnings.push(`${CONFIG_FILE}: ${key} must be a number`);
        continue;
      }
      const v = Math.round(value);
      if (v > max) warnings.push(`${CONFIG_FILE}: ${key} is at most ${max}, so it is ${max}`);
      if (v < min) warnings.push(`${CONFIG_FILE}: ${key} is at least ${min}, so it is ${min}`);
      config[key] = Math.min(max, Math.max(min, v));
    } else warnings.push(`${CONFIG_FILE}: unknown setting ${key}`);
  }
  return { config, warnings };
}
