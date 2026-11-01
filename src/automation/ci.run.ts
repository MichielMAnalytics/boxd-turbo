// boxd-turbo's automation, run on the server machine with `run boxd-turbo.run.ts`. The boxd GitHub App sends
// every push of the organization here; the handler keeps the ones `boxd-turbo init` registered.

import { readFileSync } from "node:fs";
import { githubApp } from "@boxd/run";
import { Boxd } from "@boxd-sh/sdk";
import type { BoxdLike } from "../boxd/sdk.js";
import { SERVER_ROOT } from "../boxd/server.js";
import { fsStore } from "../boxd/store.js";
import { createPool } from "../boxd/worker.js";
import { type AutomationDeps, createHandler, recoverInterruptedRuns } from "./handler.js";

// The SDK version boxd-turbo is built and tested against, signed in by the machine itself. The client
// @boxd/run provides follows the machine's runtime and can lag behind.
const boxd: BoxdLike = new Boxd();

const server = JSON.parse(readFileSync(`${SERVER_ROOT}/server.json`, "utf8")) as {
  cacheUrl: string;
  token: string;
  org?: string;
};

const deps: AutomationDeps = {
  boxd,
  store: fsStore(SERVER_ROOT),
  server,
  plannerBundle: readFileSync(`${SERVER_ROOT}/automation/planner.mjs`),
  github: githubApp,
  pool: (o) => createPool(boxd, o),
  log: (line) => console.log(line),
};
const handle = createHandler(deps);
const boot = Date.now();

// Each push runs on its own: a long run never holds up the next push.
githubApp.on("push", (e) => {
  handle(e).catch((err: Error) => console.log(`${e.repository.full_name}: ${err.stack ?? err.message}`));
});
console.log("boxd-turbo is watching pushes");

// Runs the last process was in the middle of: close them, so no check stays in progress.
recoverInterruptedRuns(deps, boot).catch((err: Error) => console.log(`closing interrupted runs: ${err.message}`));
