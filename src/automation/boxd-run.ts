// The types of `@boxd/run`, the module every boxd machine provides to automation scripts. Nothing here
// runs: the bundle keeps `@boxd/run` external, and tsconfig maps the import here for type checking.

import type { BoxdLike } from "../boxd/sdk.js";
import type { ChecksApi } from "../github/check.js";
import type { PushEvent } from "./handler.js";

export declare const boxd: BoxdLike;
export declare const githubApp: {
  on(event: "push", handler: (e: PushEvent) => unknown): void;
  getToken(): Promise<string>;
  client(): Promise<ChecksApi>;
};
