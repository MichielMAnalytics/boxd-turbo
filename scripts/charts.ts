// The README's pictures, drawn from the committed benchmark data so nobody edits a number by hand.
//
//   npx tsx scripts/charts.ts
//
// Reads bench/results/ and writes assets/*-light.svg and assets/*-dark.svg (GitHub shows the one that
// matches the reader's theme through <picture>). Colors: two categorical slots, validated for both
// modes with the dataviz palette checks (boxd CI blue, Vercel CI orange).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const assets = join(root, "assets");
const results = join(root, "bench", "results");

type Theme = {
  name: "light" | "dark";
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  boxd: string;
  vercel: string;
  wash: string;
};
const THEMES: Theme[] = [
  {
    name: "light",
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    boxd: "#2a78d6",
    vercel: "#eb6834",
    wash: "#f0efec",
  },
  {
    name: "dark",
    surface: "#1a1a19",
    ink: "#f0efec",
    ink2: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    boxd: "#3987e5",
    vercel: "#d95926",
    wash: "#2c2c2a",
  },
];
const FONT = `font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"`;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const svg = (w: number, h: number, t: Theme, body: string, title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${w}" height="${h}" rx="12" fill="${t.surface}"/>
${body}
</svg>
`;
const text = (x: number, y: number, s: string, o: { size?: number; fill: string; weight?: number; anchor?: string }) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" fill="${o.fill}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor ? ` text-anchor="${o.anchor}"` : ""}>${esc(s)}</text>`;
/** A bar growing right from x, square at the baseline, 4px round at its end. */
const bar = (x: number, y: number, w: number, h: number, fill: string, tip?: string) => {
  const r = Math.min(4, w / 2, h / 2);
  const d = `M${x},${y} h${Math.max(0, w - r)} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-Math.max(0, w - r)} z`;
  return `<path d="${d}" fill="${fill}">${tip ? `<title>${esc(tip)}</title>` : ""}</path>`;
};
const secs = (s: number) =>
  s < 90
    ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
    : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? (s[(s.length - 1) / 2] as number)
    : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};

// ── data ──────────────────────────────────────────────────────────────────────────────────────────

type BoxdRow = {
  scenario: "docs" | "leaf" | "core";
  role: string;
  result: string;
  wall_s: number;
  first_s?: number;
  machineSeconds?: Record<string, number>;
};
const SCENARIOS = [
  { key: "docs", label: "Docs-only change", sub: "nothing to rebuild" },
  { key: "leaf", label: "One provider package", sub: "packages/mistral" },
  { key: "core", label: "A core package", sub: "packages/provider-utils" },
] as const;

/** boxd's price: $0.059 per vCPU-hour and $0.018 per GiB-hour; sizes are 4 GiB per vCPU. */
const BOXD_PER_VCPU_SECOND = (0.059 + 4 * 0.018) / 3600;
const SERVER_PER_SECOND = (2 * 0.059 + 8 * 0.018) / 3600;

export function boxdMedians() {
  const rows = readFileSync(join(results, "boxd-ci.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BoxdRow)
    .filter((r) => r.role === "measured" && r.result === "success");
  const out: Record<string, { median: number; runs: number[]; usd: number; first: number }> = {};
  for (const s of SCENARIOS) {
    const rs = rows.filter((r) => r.scenario === s.key);
    if (!rs.length) throw new Error(`no measured boxd-ci run for ${s.key}`);
    // Every machine for every second it was up, and the server for the whole run.
    const usd = rs.map((r) => {
      const machines = Object.entries(r.machineSeconds ?? {}).reduce(
        (sum, [cpus, sec]) => sum + Number(cpus) * sec * BOXD_PER_VCPU_SECOND,
        0,
      );
      return machines + r.wall_s * SERVER_PER_SECOND;
    });
    const first = rs.map((r) => r.first_s).filter((x): x is number => typeof x === "number");
    if (first.length !== rs.length)
      throw new Error(`run details missing for ${s.key}: npx tsx bench/push.ts <clone> --backfill`);
    out[s.key] = {
      median: median(rs.map((r) => r.wall_s)),
      runs: rs.map((r) => r.wall_s),
      usd: median(usd),
      first: median(first),
    };
  }
  return out;
}

/** Vercel CI's bootstrapping per scenario: from the run's creation to its first job starting. */
function vercelBootstrap() {
  const rows = readFileSync(join(results, "experiment-2026-10-29.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { lane: string; scenario: string; bootstrap_s?: number });
  const out: Record<string, number> = {};
  for (const s of SCENARIOS) {
    out[s.key] = median(
      rows.filter((r) => r.lane === "vercel-ci" && r.scenario === s.key).map((r) => r.bootstrap_s ?? 0),
    );
  }
  return out;
}

function experiment() {
  return JSON.parse(readFileSync(join(results, "experiment-2026-10-29-summary.json"), "utf8")) as {
    lanes: Record<string, Record<string, { median_s: number; usd_per_run: number }>>;
  };
}

// ── the race: push to green, per scenario ─────────────────────────────────────────────────────────

function groupedBars(
  t: Theme,
  o: {
    title: string;
    subtitle: string;
    value: (lane: "boxd" | "vercel", s: string) => number;
    fmt: (v: number) => string;
    note: string;
  },
) {
  const W = 880;
  const left = 220;
  const right = 110;
  const top = 108;
  const groupH = 84;
  const barH = 22;
  const H = top + SCENARIOS.length * groupH + 46;
  const max = Math.max(...SCENARIOS.flatMap((s) => [o.value("boxd", s.key), o.value("vercel", s.key)]));
  const x = (v: number) => (v / max) * (W - left - right);
  let body = "";
  body += text(32, 44, o.title, { size: 20, weight: 650, fill: t.ink });
  body += text(32, 68, o.subtitle, { size: 13, fill: t.ink2 });
  // legend
  const lx = 32;
  body += `<rect x="${lx}" y="82" width="12" height="12" rx="3" fill="${t.boxd}"/>`;
  body += text(lx + 18, 92, "boxd CI", { size: 13, fill: t.ink });
  body += `<rect x="${lx + 92}" y="82" width="12" height="12" rx="3" fill="${t.vercel}"/>`;
  body += text(lx + 110, 92, "Vercel CI", { size: 13, fill: t.ink });
  body += `<line x1="${left}" y1="${top - 6}" x2="${left}" y2="${top + SCENARIOS.length * groupH - 14}" stroke="${t.axis}" stroke-width="1"/>`;
  SCENARIOS.forEach((s, i) => {
    const y = top + i * groupH;
    body += text(32, y + 20, s.label, { size: 14, weight: 600, fill: t.ink });
    body += text(32, y + 39, s.sub, { size: 12, fill: t.muted });
    (["boxd", "vercel"] as const).forEach((lane, j) => {
      const v = o.value(lane, s.key);
      const by = y + j * (barH + 4);
      body += bar(
        left,
        by,
        Math.max(2, x(v)),
        barH,
        lane === "boxd" ? t.boxd : t.vercel,
        `${lane === "boxd" ? "boxd CI" : "Vercel CI"}, ${s.label}: ${o.fmt(v)}`,
      );
      body += text(left + Math.max(2, x(v)) + 8, by + 16, o.fmt(v), { size: 13, weight: 600, fill: t.ink });
    });
    const b = o.value("boxd", s.key);
    const v = o.value("vercel", s.key);
    const ratio = v / b;
    if (ratio >= 1.15)
      body += text(W - 32, y + 33, `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× faster`, {
        size: 13,
        fill: t.ink2,
        anchor: "end",
      });
    else if (ratio <= 1 / 1.15)
      body += text(W - 32, y + 33, `Vercel ${(1 / ratio).toFixed(1)}× faster`, {
        size: 13,
        fill: t.ink2,
        anchor: "end",
      });
  });
  body += text(32, H - 22, o.note, { size: 12, fill: t.muted });
  return svg(W, H, t, body, `${o.title}. ${o.subtitle}`);
}

// ── a run, task by task ───────────────────────────────────────────────────────────────────────────

type RunFile = {
  id: string;
  startedAt: string;
  finishedAt: string;
  machines: number;
  results: { id: string; status: string; seconds: number; machine?: string; at?: number }[];
};

function timeline(t: Theme, run: RunFile, o: { title: string; subtitle: string }) {
  const tasks = run.results.filter(
    (r) => (r.status === "ran" || r.status === "failed") && r.at !== undefined && r.machine,
  );
  const machines = [...new Set(tasks.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((r) => r.machine as string))];
  const total = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  const W = 880;
  const left = 32;
  const right = 32;
  const top = 96;
  const lane = Math.max(5, Math.min(12, Math.floor(300 / machines.length)));
  const plotH = machines.length * lane;
  const H = top + plotH + 64;
  const x = (s: number) => left + (s / total) * (W - left - right);
  let body = text(32, 44, o.title, { size: 20, weight: 650, fill: t.ink });
  body += text(32, 68, o.subtitle, { size: 13, fill: t.ink2 });
  const step = total > 240 ? 60 : total > 90 ? 30 : 10;
  for (let s = 0; s <= total; s += step) {
    body += `<line x1="${x(s)}" y1="${top - 4}" x2="${x(s)}" y2="${top + plotH}" stroke="${t.grid}" stroke-width="1"/>`;
    body += text(x(s), top + plotH + 20, s === 0 ? "push" : secs(s), {
      size: 12,
      fill: t.muted,
      anchor: s === 0 ? "start" : "middle",
    });
  }
  for (const r of tasks) {
    const row = machines.indexOf(r.machine as string);
    const w = Math.max(2, x((r.at ?? 0) + r.seconds) - x(r.at ?? 0));
    body += bar(
      x(r.at ?? 0),
      top + row * lane,
      w,
      lane - 2,
      r.status === "failed" ? t.vercel : t.boxd,
      `${r.id}: ${secs(r.seconds)} on ${r.machine}`,
    );
  }
  body += `<line x1="${x(total)}" y1="${top - 10}" x2="${x(total)}" y2="${top + plotH}" stroke="${t.ink2}" stroke-width="2"/>`;
  body += text(x(total) - 6, top - 14, `green at ${secs(total)}`, {
    size: 12,
    weight: 600,
    fill: t.ink,
    anchor: "end",
  });
  body += text(
    32,
    H - 18,
    "Each row is a machine restored from the snapshot; each bar is one Turborepo task. Hover a bar for its name.",
    {
      size: 12,
      fill: t.muted,
    },
  );
  return svg(W, H, t, body, `${o.title}. ${o.subtitle}`);
}

// ── how it works ──────────────────────────────────────────────────────────────────────────────────

function howItWorks(t: Theme) {
  const W = 880;
  const H = 300;
  const box = (x: number, y: number, w: number, h: number, title: string, sub: string, accent = false) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${accent ? t.boxd : t.wash}"/>` +
    text(x + 14, y + 24, title, { size: 14, weight: 650, fill: accent ? "#ffffff" : t.ink }) +
    text(x + 14, y + 44, sub, { size: 12, fill: accent ? "#ffffff" : t.ink2 });
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2 - 6},${y2}" fill="none" stroke="${t.axis}" stroke-width="2"/>` +
    `<path d="M${x2 - 8},${y2 - 5} L${x2},${y2} L${x2 - 8},${y2 + 5}" fill="none" stroke="${t.axis}" stroke-width="2" stroke-linejoin="round"/>`;
  let body = text(32, 40, "How a push becomes a check", { size: 20, weight: 650, fill: t.ink });
  body += box(32, 120, 130, 62, "git push", "or boxd-ci run");
  body += box(196, 112, 190, 78, "Plan", "turbo run --dry against");
  body += text(210, 176, "the cache: what changed?", { size: 12, fill: t.ink2 });
  const machines = [
    ["@ai-sdk/mistral#test", "restored in 2 s"],
    ["@ai-sdk/mistral#type-check", "restored in 2 s"],
    ["ai#test", "restored in 2 s"],
  ] as const;
  machines.forEach(([task, sub], i) => {
    const y = 66 + i * 64;
    body += box(430, y, 230, 52, task, sub, true);
    body += arrow(386, 151, 430, y + 26);
    body += arrow(660, y + 26, 704, 151);
  });
  body += box(704, 120, 144, 62, "GitHub check", "green, red, logs");
  body += arrow(162, 151, 196, 151);
  body += text(430, 268, "One machine per task, restored from the repository's snapshot:", { size: 12, fill: t.muted });
  body += text(430, 286, "dependencies installed, outputs from the Turborepo cache.", { size: 12, fill: t.muted });
  return svg(
    W,
    H,
    t,
    body,
    "How a push becomes a check: plan with Turborepo, one snapshot machine per task, a GitHub check",
  );
}

// ── the demo: a real `boxd-ci run`, replayed at its own pace ───────────────────────────────────────

/**
 * An animated terminal from a captured run (bench/results/demo-run.txt, the CLI's plain output).
 * Each line appears at the time it printed; lines without a time appear with the summary.
 */
function demo(t: Theme, captured: string) {
  const raw = captured.replace(/\r/g, "").trimEnd().split("\n");
  const lines: { at: number; stamp: string; text: string }[] = [{ at: 0, stamp: "", text: "$ npx boxd-ci run" }];
  let last = 0.4;
  for (const l of raw) {
    const m = /^\s*([\d.]+s) {2}(.*)$/.exec(l);
    if (m) {
      last = Math.max(last, Number.parseFloat(m[1] as string));
      lines.push({ at: last, stamp: (m[1] as string).padStart(7), text: (m[2] as string).trimEnd() });
    } else lines.push({ at: last + 0.3, stamp: "", text: l.trimEnd() });
  }
  const end = (lines.at(-1)?.at ?? 1) + 0.2;
  const loop = end + 6; // hold the result before starting over
  const W = 880;
  const lh = 21;
  const top = 58;
  const H = top + lines.length * lh + 24;
  const term = {
    bg: t.name === "dark" ? "#0d0d0d" : "#1a1a19",
    ink: "#f0efec",
    dim: "#9a9890",
    ok: "#3cc43c",
    bad: "#e66767",
  };
  const pct = (sec: number) => (sec / loop) * 100;
  let css = "";
  let body = `<rect width="${W}" height="${H}" rx="12" fill="${term.bg}"/>`;
  body += ["#ec6a5e", "#f4bf4f", "#61c554"]
    .map((c, i) => `<circle cx="${24 + i * 18}" cy="24" r="6" fill="${c}"/>`)
    .join("");
  body += `<text x="${W / 2}" y="29" font-size="12" fill="${term.dim}" text-anchor="middle">boxd-ci run, a real run on vercel/ai at its real speed</text>`;
  lines.forEach((l, i) => {
    const color = /^(✓|green)/.test(l.text)
      ? term.ok
      : /^(✗|failed)/.test(l.text)
        ? term.bad
        : /^(\$|▸|run )/.test(l.text)
          ? term.dim
          : term.ink;
    const p = pct(l.at);
    css += `.l${i}{opacity:0;animation:a${i} ${loop.toFixed(1)}s linear infinite}@keyframes a${i}{0%,${p.toFixed(2)}%{opacity:0}${(p + 0.01).toFixed(2)}%,100%{opacity:1}}`;
    const stamp = l.stamp ? `<tspan fill="${term.dim}">${esc(l.stamp)}  </tspan>` : "";
    body += `<text class="l${i}" x="24" y="${top + i * lh + 14}" font-size="13.5" fill="${color}" xml:space="preserve">${stamp}${esc(l.text)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" role="img" aria-label="An animated terminal: boxd-ci run on vercel/ai">
<title>boxd-ci run on vercel/ai</title>
<style>${css}@media (prefers-reduced-motion: reduce){text{animation:none!important;opacity:1!important}}</style>
${body}
</svg>
`;
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────────

const boxd = boxdMedians();
const exp = experiment();
const vercel = exp.lanes["vercel-ci"] as Record<string, { median_s: number; usd_per_run: number }>;
const bootstrap = vercelBootstrap();
const runFile = JSON.parse(readFileSync(join(results, "core-run.json"), "utf8")) as RunFile;
const ran = runFile.results.filter((r) => r.status === "ran").length;

for (const t of THEMES) {
  writeFileSync(
    join(assets, `race-${t.name}.svg`),
    groupedBars(t, {
      title: "Push to green on vercel/ai",
      subtitle: "Median of 3 pushes each, from git push to the result on GitHub. Same commit, same tasks.",
      value: (lane, s) => (lane === "boxd" ? (boxd[s]?.median ?? 0) : (vercel[s]?.median_s ?? 0)),
      fmt: secs,
      note: "type-check and test of 84 packages (249 tasks), tagged ci the Vercel CI way. Raw runs in bench/results.",
    }),
  );
  writeFileSync(
    join(assets, `cost-${t.name}.svg`),
    groupedBars(t, {
      title: "What one run costs",
      subtitle: "Median per push, at list prices. boxd: every machine for every second it was up, plus the server.",
      value: (lane, s) => (lane === "boxd" ? (boxd[s]?.usd ?? 0) : (vercel[s]?.usd_per_run ?? 0)),
      fmt: (v) => (v < 0.1 ? `${(v * 100).toFixed(1)}¢` : `$${v.toFixed(2)}`),
      note: "Vercel CI: $0.0035 per CPU-minute. boxd: $0.059 per vCPU-hour and $0.018 per GiB-hour.",
    }),
  );
  writeFileSync(
    join(assets, `first-${t.name}.svg`),
    groupedBars(t, {
      title: "Before the first task runs",
      subtitle:
        "Median seconds from the run starting to its first task starting, or to its result when the cache had everything.",
      value: (lane, s) => (lane === "boxd" ? (boxd[s]?.first ?? 0) : (bootstrap[s] ?? 0)),
      fmt: secs,
      note: "Vercel CI: bootstrapping, from vercel ci inspect. boxd CI: restore the snapshot, check out, plan with Turborepo.",
    }),
  );
  writeFileSync(
    join(assets, `timeline-${t.name}.svg`),
    timeline(t, runFile, {
      title: "A core change, task by task",
      subtitle: `${ran} tasks on ${runFile.machines} machines, each starting the moment its dependencies were done.`,
    }),
  );
  writeFileSync(join(assets, `how-${t.name}.svg`), howItWorks(t));
  writeFileSync(join(assets, `demo-${t.name}.svg`), demo(t, readFileSync(join(results, "demo-run.txt"), "utf8")));
}
// The README's table, from the same numbers as the charts.
const cents = (v: number) => (v < 1 ? `${(v * 100).toFixed(1)}¢` : `$${v.toFixed(2)}`);
const rows = SCENARIOS.map((s) => {
  const b = boxd[s.key] as { median: number; usd: number };
  const v = vercel[s.key] as { median_s: number; usd_per_run: number };
  const r = v.median_s / b.median;
  return `| ${s.label} | **${secs(b.median)}** | ${secs(v.median_s)} | ${r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× slower`} | ${cents(b.usd)} | ${cents(v.usd_per_run)} |`;
});
writeFileSync(
  join(results, "summary.md"),
  [
    "| Push to green on vercel/ai | boxd CI | Vercel CI | | Cost, boxd CI | Cost, Vercel CI |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
console.log("boxd medians", JSON.stringify(boxd));
console.log("wrote assets/{race,cost,first,timeline,how,demo}-{light,dark}.svg and bench/results/summary.md");
