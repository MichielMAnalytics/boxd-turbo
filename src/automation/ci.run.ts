// boxd-ci's automation, run on the server machine with `run boxd-ci.run.ts`. The boxd GitHub App sends
// every push of the organization here; the handler keeps the ones `boxd-ci init` registered.

import { readFileSync } from "node:fs";
import { boxd, githubApp } from "@boxd/run";
import { SERVER_ROOT } from "../boxd/server.js";
import { fsStore } from "../boxd/store.js";
import { createPool } from "../boxd/worker.js";
import { createHandler } from "./handler.js";

const server = JSON.parse(readFileSync(`${SERVER_ROOT}/server.json`, "utf8")) as {
  cacheUrl: string;
  token: string;
  org?: string;
};

const handle = createHandler({
  boxd,
  store: fsStore(SERVER_ROOT),
  server,
  plannerBundle: readFileSync(`${SERVER_ROOT}/automation/planner.mjs`),
  github: githubApp,
  pool: (o) => createPool(boxd, o),
  log: (line) => console.log(line),
});

// Each push runs on its own: a long run never holds up the next push.
githubApp.on("push", (e) => {
  handle(e).catch((err: Error) => console.log(`${e.repository.full_name}: ${err.stack ?? err.message}`));
});
console.log("boxd-ci is watching pushes");
