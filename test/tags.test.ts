import { describe, expect, test } from "vitest";
import { resolveCiTasks, type Workspace } from "../src/core/tags.js";

const root = (name = "//", scripts: string[] = []): Workspace => ({ name, dir: ".", scripts });
const pkg = (name: string, scripts: string[], turboJson?: unknown): Workspace => ({
  name,
  dir: `packages/${name}`,
  scripts,
  turboJson,
});
const selectors = (r: ReturnType<typeof resolveCiTasks>) => r.tasks.map((t) => t.selector);

describe("resolveCiTasks", () => {
  test("a root task tagged ci selects it in every package that has the script", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci"] } } }, [
      root(),
      pkg("web", ["test", "build"]),
      pkg("docs", ["build"]),
      pkg("api", ["test"]),
    ]);
    expect(selectors(r)).toEqual(["api#test", "web#test"]);
  });

  test("!ci in a package excludes that package", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci"] } } }, [
      pkg("web", ["test"]),
      pkg("legacy", ["test"], { extends: ["//"], tasks: { test: { tags: ["!ci"] } } }),
    ]);
    expect(selectors(r)).toEqual(["web#test"]);
  });

  test("!ci wins over ci on the same task", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci", "!ci"] } } }, [pkg("web", ["test"])]);
    expect(selectors(r)).toEqual([]);
  });

  test("$TURBO_EXTENDS$ keeps the root's ci tag and adds the package's cpus", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci"] } } }, [
      pkg("web", ["test"], { tasks: { test: { tags: ["$TURBO_EXTENDS$", "ci:cpus:8"] } } }),
    ]);
    expect(r.tasks).toEqual([{ selector: "web#test", cpus: 8 }]);
  });

  test("package task tags without $TURBO_EXTENDS$ replace the root's", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci"] } } }, [
      pkg("web", ["test"], { tasks: { test: { tags: ["ci:cpus:4"] } } }),
    ]);
    expect(selectors(r)).toEqual([]);
  });

  test("a package config can opt a task into ci on its own", () => {
    const r = resolveCiTasks({ tasks: { test: {} } }, [
      pkg("web", ["test"], { tasks: { test: { tags: ["ci"] } } }),
      pkg("api", ["test"]),
    ]);
    expect(selectors(r)).toEqual(["web#test"]);
  });

  test("a root key pkg#task applies to that package only", () => {
    const r = resolveCiTasks({ tasks: { "web#build": { tags: ["ci"] } } }, [
      pkg("web", ["build"]),
      pkg("api", ["build"]),
    ]);
    expect(selectors(r)).toEqual(["web#build"]);
  });

  test("//#task selects a root package task", () => {
    const r = resolveCiTasks({ tasks: { "//#lint": { tags: ["ci"] } } }, [root("//", ["lint"]), pkg("web", ["lint"])]);
    expect(selectors(r)).toEqual(["//#lint"]);
  });

  test("a plain root task name does not apply to the root package of a monorepo", () => {
    const r = resolveCiTasks({ tasks: { lint: { tags: ["ci"] } } }, [root("//", ["lint"]), pkg("web", ["lint"])]);
    expect(selectors(r)).toEqual(["web#lint"]);
  });

  test("a single-package repo selects plain task names", () => {
    const r = resolveCiTasks({ tasks: { lint: { tags: ["ci"] }, test: { tags: ["ci"] } } }, [
      root("//", ["lint", "test", "dev"]),
    ]);
    expect(selectors(r)).toEqual(["lint", "test"]);
  });

  test("a top-level package tag sets the default cpus, a task tag overrides it", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci"] }, lint: { tags: ["ci"] } } }, [
      pkg("web", ["test", "lint"], {
        tags: ["ci:cpus:4"],
        tasks: { lint: { tags: ["$TURBO_EXTENDS$", "ci:cpus:1"] } },
      }),
    ]);
    expect(r.tasks).toEqual([
      { selector: "web#lint", cpus: 1 },
      { selector: "web#test", cpus: 4 },
    ]);
  });

  test("cpus between boxd sizes round up, above 8 cap at 8 with a warning", () => {
    const r = resolveCiTasks(
      { tasks: { test: { tags: ["ci", "ci:cpus:3"] }, build: { tags: ["ci", "ci:cpus:16"] } } },
      [pkg("web", ["test", "build"])],
    );
    expect(r.tasks).toEqual([
      { selector: "web#build", cpus: 8 },
      { selector: "web#test", cpus: 4 },
    ]);
    expect(r.warnings).toEqual(["web#build asks for 16 CPUs and boxd's largest machine has 8, so it runs on 8"]);
  });

  test("an unreadable ci:cpus value runs on the default size with a warning", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci", "ci:cpus:lots"] } } }, [pkg("web", ["test"])]);
    expect(r.tasks).toEqual([{ selector: "web#test" }]);
    expect(r.warnings).toEqual(["web#test has an unreadable tag ci:cpus:lots, so it runs on the default size"]);
  });

  test("ci:os tags are accepted and ignored", () => {
    const r = resolveCiTasks({ tasks: { test: { tags: ["ci", "ci:os:ubuntu"] } } }, [pkg("web", ["test"])]);
    expect(r.tasks).toEqual([{ selector: "web#test" }]);
    expect(r.warnings).toEqual([]);
  });

  test("a turbo.json without tasks selects nothing", () => {
    expect(selectors(resolveCiTasks({}, [pkg("web", ["test"])]))).toEqual([]);
    expect(selectors(resolveCiTasks(null, [pkg("web", ["test"])]))).toEqual([]);
  });
});
