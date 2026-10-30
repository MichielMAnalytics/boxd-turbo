import { defineConfig } from "tsup";

// Three outputs: the CLI people run, the planner that runs on a snapshot machine, and the bundle
// the automation on the controller machine imports. Each is one self-contained ESM file.
export default defineConfig([
  {
    entry: { cli: "src/cli/index.ts" },
    format: "esm",
    platform: "node",
    target: "node20",
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: "#!/usr/bin/env node" },
    clean: true,
  },
  {
    entry: { planner: "src/planner/planner.ts", automation: "src/automation/bundle.ts" },
    format: "esm",
    platform: "node",
    target: "node20",
    outExtension: () => ({ js: ".mjs" }),
    noExternal: [/.*/],
  },
]);
