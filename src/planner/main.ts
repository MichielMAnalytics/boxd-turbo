// `node planner.mjs [repo dir]`: prints the plan as JSON on stdout, or {"error": "..."} and exit 1.
import { plan } from "./planner.js";

plan({ cwd: process.argv[2] ?? process.cwd() }).then(
  (p) => process.stdout.write(`${JSON.stringify(p)}\n`),
  (e: unknown) => {
    process.stdout.write(`${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`);
    process.exit(1);
  },
);
