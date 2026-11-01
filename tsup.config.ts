import { defineConfig } from "tsup";

// Three self-contained ESM files: the CLI people run, the planner that runs on a snapshot machine,
// and the automation the server machine runs for pushes. `@boxd/run` exists only inside boxd machines.
const shared = { format: "esm", platform: "node", target: "node20", outExtension: () => ({ js: ".mjs" }) } as const;

export default defineConfig([
  { ...shared, entry: { cli: "src/cli/index.ts" }, banner: { js: "#!/usr/bin/env node" }, clean: true },
  { ...shared, entry: { planner: "src/planner/main.ts" }, noExternal: [/.*/] },
  {
    ...shared,
    entry: { "boxd-turbo.run": "src/automation/ci.run.ts" },
    noExternal: [/^(?!@boxd\/run$).*/],
    external: ["@boxd/run"],
  },
]);
