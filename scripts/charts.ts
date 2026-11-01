// The README's pictures, drawn from the committed benchmark data so nobody edits a number by hand.
//
//   npx tsx scripts/charts.ts
//
// Reads bench/results/ and writes assets/*-light.svg and assets/*-dark.svg (GitHub shows the one that
// matches the reader's theme through <picture>).
//
// The look is boxd's, from the website's brand guide and its benchmark board: a monochrome UI, Inter
// for prose and JetBrains Mono for labels and numbers, tiles on a grout frame, the notch from the
// logo on every panel. Colour is data only, by emphasis: boxd-turbo's bars in emerald, everyone else's
// in grey, checked for colour-vision deficiency in both modes. Every bar carries its name and value,
// so colour is never the only cue. The fonts are subset per picture and embedded, since GitHub shows
// an SVG as an image, which loads no fonts of its own.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";

const root = fileURLToPath(new URL("..", import.meta.url));
const assets = join(root, "assets");
const results = join(root, "bench", "results");
const fonts = join(root, "scripts", "fonts");

type Theme = {
  name: "light" | "dark";
  /** The panel's ground and its hairline. */
  page: string;
  edge: string;
  /** The frame showing through the seams between tiles, and the seam's width. */
  grout: string;
  pad: number;
  tile: string;
  /** A bar's empty track. */
  track: string;
  /** Text, from headings down to footnotes. */
  ink: string;
  body: string;
  quiet: string;
  muted: string;
  deep: string;
  /** A rule inside a tile, and a gridline. */
  rule: string;
  /** Data: boxd-turbo by emphasis, everyone else in grey. */
  boxd: string;
  other: string;
  /** The logo's fill. */
  mark: string;
  /** The rose light in the panel's corner, dark mode only. */
  bloom: boolean;
};

// Zinc, as the site uses it. Dark: the site's page and tile grounds. Light: the site's light section.
const THEMES: Theme[] = [
  {
    name: "light",
    page: "#e8e8ec",
    edge: "#d4d4d8",
    grout: "#a1a1aa",
    pad: 1,
    tile: "#ffffff",
    track: "rgba(0,0,0,0.05)",
    ink: "#18181b",
    body: "#52525b",
    quiet: "#52525b",
    muted: "#71717a",
    deep: "#71717a",
    rule: "#e4e4e7",
    // Emerald 800 against grey: ΔE 18.4 under protanopia, both over 3:1 on white.
    boxd: "#065f46",
    other: "#8a8a93",
    mark: "#18181b",
    bloom: false,
  },
  {
    name: "dark",
    page: "#0a0c12",
    edge: "rgba(255,255,255,0.08)",
    grout: "#3f3f46",
    pad: 2,
    tile: "#100c0e",
    track: "rgba(255,255,255,0.035)",
    ink: "#f4f4f5",
    body: "#d4d4d8",
    quiet: "#a1a1aa",
    muted: "#71717a",
    deep: "#52525b",
    rule: "rgba(39,39,42,0.8)",
    // The benchmark board's pair: ΔE 22.7 under deuteranopia, both over 3:1 on the tile.
    boxd: "#34d399",
    other: "#71717a",
    mark: "#e4e4e7",
    bloom: true,
  },
];

/** The terminal is the product's screenshot: dark in both modes, as on the site. */
const TERM = {
  ground: "#0e1118",
  edge: "rgba(255,255,255,0.08)",
  chrome: "rgba(255,255,255,0.02)",
  chromeEdge: "rgba(255,255,255,0.06)",
  light: "rgba(255,255,255,0.08)",
  prompt: "#f4f4f5",
  command: "#f4f4f5",
  text: "#d4d4d8",
  result: "#a1a1aa",
  dim: "#71717a",
  comment: "#52525b",
  /** Success green: terminal status only. */
  ok: "#7DB89E",
};

const SANS = "'boxd-sans', Inter, system-ui, -apple-system, sans-serif";
const MONO = "'boxd-mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
/** JetBrains Mono's advance is 600 units per 1000: every glyph is 0.6 em wide. */
const monoWidth = (s: string, size: number) => [...s].length * size * 0.6;

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One picture: its body, and the characters each font face has to carry. */
class Doc {
  body = "";
  defs = "";
  css = "";
  readonly used = { sans400: new Set<string>(), sans500: new Set<string>(), mono: new Set<string>() };
  constructor(
    readonly w: number,
    readonly h: number,
    readonly label: string,
  ) {}

  text(
    x: number,
    y: number,
    s: string,
    o: {
      font?: "sans" | "mono";
      size?: number;
      fill: string;
      weight?: 400 | 500;
      anchor?: "start" | "middle" | "end";
      tracking?: string;
      cls?: string;
    },
  ) {
    const font = o.font ?? "sans";
    const face = font === "mono" ? this.used.mono : o.weight === 500 ? this.used.sans500 : this.used.sans400;
    for (const c of s) face.add(c);
    const attrs = [
      `x="${x.toFixed(1)}"`,
      `y="${y.toFixed(1)}"`,
      `font-family="${font === "mono" ? MONO : SANS}"`,
      `font-size="${o.size ?? 13}"`,
      `fill="${o.fill}"`,
      o.weight === 500 ? `font-weight="500"` : "",
      o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
      o.tracking ? `letter-spacing="${o.tracking}"` : "",
      o.cls ? `class="${o.cls}"` : "",
    ].filter(Boolean);
    return `<text ${attrs.join(" ")} xml:space="preserve">${esc(s)}</text>`;
  }

  /** Spans of one line, each with its own colour, drawn as one text element. */
  spans(x: number, y: number, parts: [string, string][], o: { size: number; cls?: string }) {
    for (const [s] of parts) for (const c of s) this.used.mono.add(c);
    const body = parts.map(([s, fill]) => `<tspan fill="${fill}">${esc(s)}</tspan>`).join("");
    return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${o.size}"${o.cls ? ` class="${o.cls}"` : ""} xml:space="preserve">${body}</text>`;
  }

  /** Kicker: uppercase mono, wide tracking, muted. */
  kicker(x: number, y: number, s: string, t: Theme) {
    return this.text(x, y, s.toUpperCase(), { font: "mono", size: 10.5, fill: t.muted, tracking: "0.15em" });
  }

  async render(): Promise<string> {
    const faces: [keyof Doc["used"], string, string, number][] = [
      ["sans400", "Inter-Regular.ttf", "boxd-sans", 400],
      ["sans500", "Inter-Medium.ttf", "boxd-sans", 500],
      ["mono", "JetBrainsMono-Regular.ttf", "boxd-mono", 400],
    ];
    let fontCss = "";
    for (const [key, file, family, weight] of faces) {
      const chars = [...this.used[key]].join("");
      if (!chars) continue;
      const woff2 = await subsetFont(readFileSync(join(fonts, file)), `${chars} `, { targetFormat: "woff2" });
      fontCss += `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${woff2.toString("base64")}) format('woff2')}`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" role="img" aria-label="${esc(this.label)}">
<title>${esc(this.label)}</title>
<style>${fontCss}${this.css}</style>
<defs>${this.defs}</defs>
${this.body}
</svg>
`;
  }
}

// ── boxd's shapes ─────────────────────────────────────────────────────────────────────────────────

/**
 * A rounded rectangle with the logo's notch cut from its bottom-left corner: the website's
 * getBoxPath, stretched to any width and height. Notch n, outer and inner radius r.
 */
function notched(x: number, y: number, w: number, h: number, r: number, n: number, ri = r): string {
  const b = y + h;
  return [
    `M${x + r},${y}`,
    `L${x + w - r},${y}`,
    `A${r},${r} 0 0 1 ${x + w},${y + r}`,
    `L${x + w},${b - r}`,
    `A${r},${r} 0 0 1 ${x + w - r},${b}`,
    `L${x + n + r},${b}`,
    `A${r},${r} 0 0 1 ${x + n},${b - r}`,
    `L${x + n},${b - n + ri}`,
    `A${ri},${ri} 0 0 0 ${x + n - ri},${b - n}`,
    `L${x + r},${b - n}`,
    `A${r},${r} 0 0 1 ${x},${b - n - r}`,
    `L${x},${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    "Z",
  ].join(" ");
}

/** The boxd logo: a square with its bottom-left notch, at 20% of its size. */
const logo = (x: number, y: number, size: number, fill: string) =>
  `<path d="${notched(x, y, size, size, size / 12, size * 0.2)}" fill="${fill}"/>`;

/** Vercel's mark, the triangle, in the colour of the text beside it. */
const triangle = (x: number, y: number, size: number, fill: string) =>
  `<path d="M${x + size / 2},${y + size * 0.07} L${x + size},${y + size * 0.93} L${x},${y + size * 0.93} Z" fill="${fill}"/>`;

/** The outer panel: notched like the site's NotchedPanel (radius 12, notch 28), lit from above. */
function panel(d: Doc, t: Theme) {
  const shape = notched(0.75, 0.75, d.w - 1.5, d.h - 1.5, 12, 28);
  d.defs += `<clipPath id="p"><path d="${shape}"/></clipPath>`;
  d.defs += `<linearGradient id="lip" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="${t.bloom ? 0.12 : 0.6}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
  let out = `<path d="${shape}" fill="${t.page}"/>`;
  if (t.bloom) {
    // The brand's rose, as light in a corner: never on a mark or a word.
    d.defs += `<radialGradient id="rose" cx="0.88" cy="0.92" r="0.55"><stop offset="0" stop-color="rgb(224,90,109)" stop-opacity="0.10"/><stop offset="1" stop-color="rgb(224,90,109)" stop-opacity="0"/></radialGradient>`;
    out += `<rect width="${d.w}" height="${d.h}" fill="url(#rose)" clip-path="url(#p)"/>`;
  }
  out += `<rect x="${d.w * 0.1}" y="1" width="${d.w * 0.8}" height="1" fill="url(#lip)"/>`;
  out += `<path d="${shape}" fill="none" stroke="${t.edge}" stroke-width="1.5"/>`;
  return out;
}

/** Tiles on a grout frame: the frame shows through the seams, so no tile has a border. */
function grout(t: Theme, x: number, y: number, w: number, h: number, cols: number) {
  const R = 16;
  const tw = (w - t.pad * (cols + 1)) / cols;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${R + t.pad}" fill="${t.grout}"/>`;
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < cols; i++) {
    const tx = x + t.pad + i * (tw + t.pad);
    tiles.push({ x: tx, y: y + t.pad, w: tw, h: h - 2 * t.pad });
    out += `<rect x="${tx}" y="${y + t.pad}" width="${tw}" height="${h - 2 * t.pad}" rx="${R}" fill="${t.tile}"/>`;
  }
  return { svg: out, tiles };
}

/** A bar as on the site's benchmark board: 8 px, square-ish at the start, rounded at its end. */
const bar = (x: number, y: number, w: number, h: number, fill: string, tip?: string) => {
  const r = Math.min(4, w / 2, h / 2);
  const l = Math.min(1, w / 2);
  const d = `M${x + l},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + l} A${l},${l} 0 0 1 ${x},${y + h - l} V${y + l} A${l},${l} 0 0 1 ${x + l},${y} Z`;
  return `<path d="${d}" fill="${fill}">${tip ? `<title>${esc(tip)}</title>` : ""}</path>`;
};

const secs = (s: number) =>
  s < 90
    ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
    : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
/** 0.4¢, 36¢, $1.20: tenths of a cent only where they matter. */
const money = (v: number) =>
  v < 0.1 ? `${(v * 100).toFixed(1)}¢` : v < 1 ? `${Math.round(v * 100)}¢` : `$${v.toFixed(2)}`;
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

/**
 * boxd's USD list price (boxd.sh/pricing): $0.047 per vCPU-hour, $0.014 per GiB-hour of RAM in use.
 * Every machine is counted with all its RAM (4 GiB per vCPU) in use, an upper bound. Disk, at
 * $0.000096 per GiB-hour written, is left out: under a hundredth of a cent per run.
 */
const VCPU_HOUR = 0.047;
const GIB_HOUR = 0.014;
const BOXD_PER_VCPU_SECOND = (VCPU_HOUR + 4 * GIB_HOUR) / 3600;
const SERVER_PER_SECOND = (2 * VCPU_HOUR + 8 * GIB_HOUR) / 3600;
/** The server stays awake this long after a run (its auto-suspend timeout), so each push pays for it. */
const SERVER_TAIL_S = 60;

export function boxdMedians() {
  const rows = readFileSync(join(results, "boxd-turbo.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BoxdRow)
    .filter((r) => r.role === "measured" && r.result === "success");
  const out: Record<string, { median: number; runs: number[]; usd: number; first: number }> = {};
  for (const s of SCENARIOS) {
    const rs = rows.filter((r) => r.scenario === s.key);
    if (!rs.length) throw new Error(`no measured boxd-turbo run for ${s.key}`);
    // Every machine for every second it was up, and the server for the run plus the minute after it.
    const usd = rs.map((r) => {
      const machines = Object.entries(r.machineSeconds ?? {}).reduce(
        (sum, [cpus, sec]) => sum + Number(cpus) * sec * BOXD_PER_VCPU_SECOND,
        0,
      );
      return machines + (r.wall_s + SERVER_TAIL_S) * SERVER_PER_SECOND;
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

/** The earlier lanes' medians and costs: Vercel CI and the boxd prototype. */
function experiment() {
  return JSON.parse(readFileSync(join(results, "experiment-2026-10-29-summary.json"), "utf8")) as {
    lanes: Record<string, Record<string, { median_s: number; usd_per_run: number }>>;
  };
}

// ── where the time goes: each platform's median run, part by part ────────────────────────────────

/** From the end of git push to the result on GitHub: before the first task, the tasks, after the last. */
type Parts = { start: number; tasks: number; report: number; total: number };

const experimentDir = join(root, "bench", "experiment-2026-10-29");
const iso = (s: string) => Date.parse(s) / 1000;

/** The median run of three (by its total), so the parts add up to a real run's time. */
const middle = <T>(xs: T[], total: (x: T) => number): T => {
  const sorted = [...xs].sort((a, b) => total(a) - total(b));
  return sorted[Math.floor(sorted.length / 2)] as T;
};

/** Vercel CI, from `vercel ci inspect`: when its run, its Turborepo job and every task began and ended. */
function vercelParts(): Record<string, Parts> {
  const rows = readFileSync(join(experimentDir, "results-all.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          platform: string;
          role: string;
          scenario: string;
          sha: string;
          run_id: string;
          wall_s: number;
        },
    )
    .filter((r) => r.platform === "vercel" && r.role === "isolated");
  const pushes = new Map(
    readFileSync(join(experimentDir, "pushes.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { sha: string; push_end: number })
      .map((p) => [p.sha, p.push_end]),
  );
  type Inspect = {
    jobs: { completedAt: string; tasks: { startedAt?: string; completedAt?: string }[] }[];
  };
  const out: Record<string, Parts> = {};
  for (const s of SCENARIOS) {
    const r = middle(
      rows.filter((x) => x.scenario === s.key),
      (x) => x.wall_s,
    );
    const pushed = pushes.get(r.sha) as number;
    const run = JSON.parse(readFileSync(join(experimentDir, "vercel-inspect", `${r.run_id}.json`), "utf8")) as Inspect;
    const job = run.jobs[0] as Inspect["jobs"][number];
    const ran = job.tasks.filter((x) => x.startedAt && x.completedAt);
    // With nothing to run, the job's end is where its tasks would have started.
    const first = ran.length ? Math.min(...ran.map((x) => iso(x.startedAt as string))) : iso(job.completedAt);
    const last = ran.length ? Math.max(...ran.map((x) => iso(x.completedAt as string))) : first;
    out[s.key] = { start: first - pushed, tasks: last - first, report: pushed + r.wall_s - last, total: r.wall_s };
  }
  return out;
}

/** boxd-turbo, from its run records: the run's own start, its first task, and its end, when the check completes. */
function boxdParts(): Record<string, Parts> {
  const rows = readFileSync(join(results, "boxd-turbo.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BoxdRow & { run_s: number })
    .filter((r) => r.role === "measured" && r.result === "success");
  const out: Record<string, Parts> = {};
  for (const s of SCENARIOS) {
    const r = middle(
      rows.filter((x) => x.scenario === s.key),
      (x) => x.wall_s,
    );
    const before = r.wall_s - r.run_s;
    out[s.key] = { start: before + (r.first_s ?? 0), tasks: r.run_s - (r.first_s ?? 0), report: 0, total: r.wall_s };
  }
  return out;
}

// ── a comparison per scenario: one tile each, on its own scale ───────────────────────────────────

/** Header: kicker, title, subtitle, and the legend with each platform's mark. Returns its height. */
function header(d: Doc, t: Theme, o: { kicker: string; title: string; subtitle: string; legend?: boolean }) {
  d.body += d.kicker(32, 42, o.kicker, t);
  d.body += d.text(32, 76, o.title, { size: 26, fill: t.ink, tracking: "-0.02em" });
  d.body += d.text(32, 102, o.subtitle, { size: 14, fill: t.body });
  if (o.legend) {
    const size = 10.5;
    const vercel = "Vercel CI";
    const right = d.w - 32;
    const vx = right - monoWidth(vercel, 11);
    const bx = vx - 16 - 28 - monoWidth("boxd-turbo", 11);
    d.body += logo(bx, 33, size, t.mark) + d.text(bx + 16, 42, "boxd-turbo", { font: "mono", size: 11, fill: t.quiet });
    d.body += triangle(vx - 16, 32.5, 11, t.quiet) + d.text(vx, 42, vercel, { font: "mono", size: 11, fill: t.quiet });
  }
  return 124;
}

function comparison(
  t: Theme,
  o: {
    kicker: string;
    title: string;
    subtitle: string;
    value: (lane: "boxd" | "vercel", s: string) => number;
    fmt: (v: number) => string;
    notes: string[];
    /** What a shorter bar means: "faster", "cheaper", "sooner". */
    better: string;
  },
) {
  const W = 880;
  const tileH = 196;
  const top = 124;
  const H = top + tileH + 30 + o.notes.length * 18 + 18;
  const d = new Doc(W, H, `${o.title}. ${o.subtitle}`);
  d.body += panel(d, t);
  header(d, t, { ...o, legend: true });
  const g = grout(t, 24, top, W - 48, tileH, SCENARIOS.length);
  d.body += g.svg;
  SCENARIOS.forEach((s, i) => {
    const tile = g.tiles[i] as { x: number; y: number; w: number; h: number };
    const x = tile.x + 20;
    const right = tile.x + tile.w - 20;
    const y = tile.y;
    d.body += d.text(x, y + 34, s.label, { size: 15, weight: 500, fill: t.ink, tracking: "-0.01em" });
    d.body += d.text(x, y + 54, s.sub, { font: "mono", size: 11, fill: t.muted });
    const b = o.value("boxd", s.key);
    const v = o.value("vercel", s.key);
    const max = Math.max(b, v);
    // Theirs first, ours last, as on the site's board.
    const rows = [
      { lane: "vercel" as const, name: "Vercel CI", value: v, y: y + 84 },
      { lane: "boxd" as const, name: "boxd-turbo", value: b, y: y + 122 },
    ];
    for (const r of rows) {
      const ours = r.lane === "boxd";
      d.body += ours ? logo(x, r.y - 9.5, 10.5, t.mark) : triangle(x - 0.5, r.y - 10, 11, t.quiet);
      d.body += d.text(x + 17, r.y, r.name, { font: "mono", size: 11, fill: ours ? t.ink : t.quiet });
      d.body += d.text(right, r.y, o.fmt(r.value), {
        font: "mono",
        size: 12,
        fill: ours ? t.ink : t.quiet,
        anchor: "end",
      });
      const trackW = right - x;
      d.body += `<rect x="${x}" y="${r.y + 9}" width="${trackW}" height="8" rx="2" fill="${t.track}"/>`;
      d.body += bar(
        x,
        r.y + 9,
        Math.max(trackW * 0.015, (r.value / max) * trackW),
        8,
        ours ? t.boxd : t.other,
        `${r.name}, ${s.label}: ${o.fmt(r.value)}`,
      );
    }
    const ratio = v / b;
    const say =
      ratio >= 1.05
        ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× ${o.better}`
        : ratio > 0.95
          ? "about even"
          : `Vercel CI ${(1 / ratio).toFixed(1)}× ${o.better}`;
    d.body += `<line x1="${x}" y1="${y + 156}" x2="${right}" y2="${y + 156}" stroke="${t.rule}" stroke-width="1"/>`;
    d.body += d.text(x, y + 177, "boxd-turbo vs", { font: "mono", size: 11, fill: t.muted });
    d.body += d.text(x + monoWidth("boxd-turbo vs ", 11), y + 177, say, { font: "mono", size: 11, fill: t.ink });
  });
  o.notes.forEach((n, i) => {
    d.body += d.text(32, top + tileH + 30 + i * 18, n, { font: "mono", size: 11, fill: t.deep });
  });
  return d.render();
}

/** Waiting, drawn as a hatch over a neutral: it is time, but no task ran in it. */
function hatch(d: Doc, t: Theme) {
  if (d.defs.includes('id="wait"')) return;
  const base = t.name === "dark" ? "#3f3f46" : "#d4d4d8";
  const line = t.name === "dark" ? "#52525b" : "#a1a1aa";
  d.defs += `<pattern id="wait" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${base}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${line}" stroke-width="2.5"/></pattern>`;
}

function whereTimeGoes(t: Theme, vercel: Record<string, Parts>, boxd: Record<string, Parts>) {
  const W = 880;
  const tileH = 214;
  const top = 124;
  const notes = [
    "The median of 3 pushes each, from git push to the result on GitHub. Each change on its own scale.",
    "Vercel CI from vercel ci inspect, boxd-turbo from its run records. Raw data in bench/.",
  ];
  const H = top + tileH + 30 + notes.length * 18 + 18;
  const d = new Doc(
    W,
    H,
    "Where the time goes: before the first task, the tasks, and after the last task, for boxd-turbo and Vercel CI",
  );
  hatch(d, t);
  d.body += panel(d, t);
  header(d, t, {
    kicker: "boxd-turbo vs Vercel CI, on vercel/ai",
    title: "Where the time goes",
    subtitle: "Waiting before the first task and after the last one, against the tasks themselves.",
  });
  // Legend: what the two fills mean.
  const lx = d.w - 32 - monoWidth("tasks", 11);
  const wx = lx - 32 - 26 - monoWidth("waiting", 11);
  d.body += `<rect x="${wx}" y="33" width="11" height="11" rx="2" fill="url(#wait)"/>`;
  d.body += d.text(wx + 16, 42, "waiting", { font: "mono", size: 11, fill: t.quiet });
  d.body += `<rect x="${lx - 30}" y="33" width="11" height="11" rx="2" fill="${t.other}"/>`;
  d.body += `<rect x="${lx - 16}" y="33" width="11" height="11" rx="2" fill="${t.boxd}"/>`;
  d.body += d.text(lx, 42, "tasks", { font: "mono", size: 11, fill: t.quiet });
  const g = grout(t, 24, top, W - 48, tileH, SCENARIOS.length);
  d.body += g.svg;
  SCENARIOS.forEach((s, i) => {
    const tile = g.tiles[i] as { x: number; y: number; w: number; h: number };
    const x = tile.x + 20;
    const right = tile.x + tile.w - 20;
    const y = tile.y;
    const v = vercel[s.key] as Parts;
    const b = boxd[s.key] as Parts;
    const scale = (right - x) / Math.max(v.total, b.total);
    d.body += d.text(x, y + 34, s.label, { size: 15, weight: 500, fill: t.ink, tracking: "-0.01em" });
    d.body += d.text(x, y + 54, s.sub, { font: "mono", size: 11, fill: t.muted });
    const rows = [
      { lane: "vercel" as const, name: "Vercel CI", p: v, y: y + 84 },
      { lane: "boxd" as const, name: "boxd-turbo", p: b, y: y + 128 },
    ];
    for (const r of rows) {
      const ours = r.lane === "boxd";
      d.body += ours ? logo(x, r.y - 9.5, 10.5, t.mark) : triangle(x - 0.5, r.y - 10, 11, t.quiet);
      d.body += d.text(x + 17, r.y, r.name, { font: "mono", size: 11, fill: ours ? t.ink : t.quiet });
      d.body += d.text(right, r.y, secs(r.p.total), {
        font: "mono",
        size: 12,
        fill: ours ? t.ink : t.quiet,
        anchor: "end",
      });
      const by = r.y + 9;
      const h = 16;
      let at = x;
      const parts = [
        { w: r.p.start, fill: "url(#wait)", what: "before the first task", label: t.ink },
        {
          w: r.p.tasks,
          fill: ours ? t.boxd : t.other,
          what: "tasks",
          label: t.name === "dark" ? "#09090b" : "#ffffff",
        },
        {
          w: r.p.report,
          fill: "url(#wait)",
          what: "after the last task, until the result was on GitHub",
          label: t.ink,
        },
      ].filter((p) => p.w > 0.05);
      parts.forEach((p, j) => {
        const w = Math.max(2, p.w * scale);
        const isFirst = j === 0;
        const isLast = j === parts.length - 1;
        const rl = isFirst ? 2 : 0;
        const rr = isLast ? 4 : 0;
        const path = `M${at + rl},${by} H${at + w - rr} ${rr ? `A${rr},${rr} 0 0 1 ${at + w},${by + rr} V${by + h - rr} A${rr},${rr} 0 0 1 ${at + w - rr},${by + h}` : `V${by + h}`} H${at + rl} ${rl ? `A${rl},${rl} 0 0 1 ${at},${by + h - rl} V${by + rl} A${rl},${rl} 0 0 1 ${at + rl},${by}` : `V${by}`} Z`;
        d.body += `<path d="${path}" fill="${p.fill}"><title>${esc(`${r.name}, ${s.label}: ${secs(p.w)} ${p.what}`)}</title></path>`;
        const label = secs(p.w);
        if (w >= monoWidth(label, 10) + 10) {
          d.body += d.text(at + w / 2, by + 11.5, label, { font: "mono", size: 10, fill: p.label, anchor: "middle" });
        }
        // A seam between parts, as between tiles.
        if (!isLast) d.body += `<rect x="${at + w - 1}" y="${by}" width="2" height="${h}" fill="${t.tile}"/>`;
        at += w;
      });
    }
    const waitV = v.start + v.report;
    const waitB = b.start + b.report;
    d.body += `<line x1="${x}" y1="${y + 172}" x2="${right}" y2="${y + 172}" stroke="${t.rule}" stroke-width="1"/>`;
    d.body += d.text(x, y + 194, "waiting", { font: "mono", size: 11, fill: t.muted });
    let wx2 = x + monoWidth("waiting  ", 11);
    d.body += triangle(wx2, y + 184, 11, t.quiet);
    wx2 += 15;
    d.body += d.text(wx2, y + 194, secs(waitV), { font: "mono", size: 11, fill: t.quiet });
    wx2 += monoWidth(`${secs(waitV)}  `, 11);
    d.body += logo(wx2, y + 184.5, 10.5, t.mark);
    d.body += d.text(wx2 + 15, y + 194, secs(waitB), { font: "mono", size: 11, fill: t.ink });
  });
  notes.forEach((n, i) => {
    d.body += d.text(32, top + tileH + 30 + i * 18, n, { font: "mono", size: 11, fill: t.deep });
  });
  return d.render();
}

// ── a run, task by task ───────────────────────────────────────────────────────────────────────────

type RunFile = {
  id: string;
  startedAt: string;
  finishedAt: string;
  machines: number;
  results: { id: string; status: string; seconds: number; machine?: string; at?: number }[];
};

function timeline(t: Theme, run: RunFile, o: { kicker: string; title: string; subtitle: string; notes: string[] }) {
  const tasks = run.results.filter(
    (r) => (r.status === "ran" || r.status === "failed") && r.at !== undefined && r.machine,
  );
  const machines = [...new Set(tasks.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((r) => r.machine as string))];
  const total = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
  const W = 880;
  const top = 124;
  const lane = Math.max(6, Math.min(10, Math.floor(300 / machines.length)));
  const plotTop = top + 48;
  const plotH = machines.length * lane;
  const tileH = plotH + 48 + 44;
  const H = top + tileH + 30 + o.notes.length * 18 + 18;
  const d = new Doc(W, H, `${o.title}. ${o.subtitle}`);
  d.body += panel(d, t);
  header(d, t, o);
  const g = grout(t, 24, top, W - 48, tileH, 1);
  d.body += g.svg;
  const tile = g.tiles[0] as { x: number; w: number };
  const left = tile.x + 20;
  const right = tile.x + tile.w - 20;
  const x = (s: number) => left + (s / total) * (right - left);
  d.body += logo(left, top + 22.5, 10.5, t.mark);
  d.body += d.text(left + 17, top + 32, `${machines.length} machines, one row each`, {
    font: "mono",
    size: 11,
    fill: t.quiet,
  });
  const step = total > 240 ? 60 : total > 90 ? 30 : 10;
  for (let s = 0; s <= total; s += step) {
    d.body += `<line x1="${x(s)}" y1="${plotTop - 4}" x2="${x(s)}" y2="${plotTop + plotH}" stroke="${t.rule}" stroke-width="1"/>`;
    d.body += d.text(x(s), plotTop + plotH + 22, s === 0 ? "start" : s % 60 === 0 ? `${s / 60} min` : `${s} s`, {
      font: "mono",
      size: 11,
      fill: t.muted,
      anchor: s === 0 ? "start" : "middle",
    });
  }
  for (const r of tasks) {
    const row = machines.indexOf(r.machine as string);
    const w = Math.max(2, x((r.at ?? 0) + r.seconds) - x(r.at ?? 0));
    d.body += bar(
      x(r.at ?? 0),
      plotTop + row * lane + 1,
      w,
      lane - 2,
      r.status === "failed" ? t.other : t.boxd,
      `${r.id}: ${secs(r.seconds)} on ${r.machine}`,
    );
  }
  d.body += `<line x1="${x(total)}" y1="${plotTop - 12}" x2="${x(total)}" y2="${plotTop + plotH}" stroke="${t.quiet}" stroke-width="1.5"/>`;
  const done = `green after ${secs(total)}`;
  const dx = x(total) - 8 - monoWidth(done, 11);
  d.body += d.text(dx - 14, plotTop - 16, "✓", { font: "mono", size: 11, fill: TERM.ok });
  d.body += d.text(dx, plotTop - 16, done, { font: "mono", size: 11, fill: t.ink });
  o.notes.forEach((n, i) => {
    d.body += d.text(32, top + tileH + 30 + i * 18, n, { font: "mono", size: 11, fill: t.deep });
  });
  return d.render();
}

// ── how it works ──────────────────────────────────────────────────────────────────────────────────

function howItWorks(t: Theme) {
  const W = 880;
  const H = 360;
  const d = new Doc(
    W,
    H,
    "How a push becomes a check: plan with Turborepo, schedule each task on a snapshot machine, a GitHub check",
  );
  d.body += panel(d, t);
  header(d, t, {
    kicker: "How it works",
    title: "How a push becomes a check",
    subtitle: "Each task starts the moment its dependencies are done, on a machine restored from the snapshot.",
  });
  const node = (x: number, y: number, w: number, h: number, title: string, sub: string, mono = false) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.tile}" stroke="${t.grout}" stroke-width="${t.pad === 2 ? 1 : 1}"/>` +
    d.text(
      x + 16,
      y + 26,
      title,
      mono ? { font: "mono", size: 12, fill: t.ink } : { size: 14, weight: 500, fill: t.ink },
    ) +
    d.text(x + 16, y + 46, sub, { font: "mono", size: 11, fill: t.muted });
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2 - 5},${y2}" fill="none" stroke="${t.grout}" stroke-width="1.5"/>` +
    `<path d="M${x2 - 7},${y2 - 4} L${x2},${y2} L${x2 - 7},${y2 + 4}" fill="none" stroke="${t.grout}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  const mid = 236;
  d.body += node(32, mid - 32, 132, 64, "git push", "or boxd-turbo run", true);
  d.body += node(196, mid - 40, 196, 80, "Plan", "turbo run --dry");
  d.body += d.text(212, mid + 26, "against the cache", { font: "mono", size: 11, fill: t.muted });
  const machines = ["@ai-sdk/mistral#test", "@ai-sdk/mistral#type-check", "ai#test"];
  machines.forEach((task, i) => {
    const y = 150 + i * 62;
    // A machine is a box: the logo's notch, at the size of a node.
    d.body += `<path d="${notched(432, y, 236, 50, 10, 14, 4)}" fill="${t.tile}" stroke="${t.grout}" stroke-width="1"/>`;
    d.body += d.text(452, y + 21, task, { font: "mono", size: 12, fill: t.ink });
    d.body += `<rect x="452" y="${y + 30}" width="${monoWidth(task, 12)}" height="6" rx="2" fill="${t.track}"/>`;
    d.body += bar(452, y + 30, monoWidth(task, 12) * (i === 2 ? 1 : 0.35 + i * 0.25), 6, t.boxd);
    d.body += arrow(392, mid, 432, y + 25);
    d.body += arrow(668, y + 25, 708, mid);
  });
  d.body += node(708, mid - 32, 140, 64, "GitHub check", "green, red, logs");
  d.body += arrow(164, mid, 196, mid);
  d.body += logo(452, 120.5, 10.5, t.mark);
  d.body += d.text(469, 130, "machines from the snapshot", { font: "mono", size: 11, fill: t.quiet });
  return d.render();
}

// ── the demo: a real `boxd-turbo run`, replayed at its own pace ───────────────────────────────────────

/**
 * An animated terminal from a captured run (bench/results/demo-run.txt, the CLI's plain output), in
 * the site's terminal style: monochrome chrome, success green only on a status, and the notched box
 * as the cursor. Each line appears at the time it printed; lines without a time appear with the
 * summary.
 */
function demo(captured: string) {
  const raw = captured.replace(/\r/g, "").trimEnd().split("\n");
  type Line = { at: number; parts: [string, string][] };
  const lines: Line[] = [
    {
      at: 0,
      parts: [
        ["$ ", TERM.prompt],
        ["npx github:azin-tech/boxd-turbo run", TERM.command],
      ],
    },
  ];
  const colour = (text: string): [string, string][] => {
    if (/^[✓✗] /.test(text))
      return [
        [text.slice(0, 2), TERM.ok],
        [text.slice(2), TERM.result],
      ];
    if (text.startsWith("▸ ")) return [[text, TERM.dim]];
    if (text.startsWith("green "))
      return [
        ["green", TERM.ok],
        [text.slice(5), TERM.text],
      ];
    if (text.startsWith("run ")) return [[text, TERM.comment]];
    return [[text, TERM.text]];
  };
  let last = 0.4;
  for (const l of raw) {
    const m = /^\s*([\d.]+s) {2}(.*)$/.exec(l);
    if (m) {
      last = Math.max(last, Number.parseFloat(m[1] as string));
      lines.push({
        at: last,
        parts: [[`${(m[1] as string).padStart(6)}  `, TERM.comment], ...colour((m[2] as string).trimEnd())],
      });
    } else lines.push({ at: last + 0.3, parts: colour(l.trimEnd()) });
  }
  const end = (lines.at(-1)?.at ?? 1) + 0.4;
  lines.push({ at: end, parts: [["$ ", TERM.prompt]] });
  const loop = end + 6; // hold the result before starting over
  const W = 880;
  const lh = 23;
  const chrome = 38;
  const top = chrome + 26;
  const H = top + lines.length * lh + 16;
  const d = new Doc(W, H, "An animated terminal: boxd-turbo run on vercel/ai");
  d.body += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${TERM.ground}" stroke="${TERM.edge}"/>`;
  d.body += `<path d="M12.5,0.5 H${W - 12.5} A12,12 0 0 1 ${W - 0.5},12.5 V${chrome} H0.5 V12.5 A12,12 0 0 1 12.5,0.5 Z" fill="${TERM.chrome}"/>`;
  d.body += `<line x1="0.5" y1="${chrome}" x2="${W - 0.5}" y2="${chrome}" stroke="${TERM.chromeEdge}"/>`;
  // Traffic lights, monochrome as on the site.
  d.body += [0, 1, 2]
    .map((i) => `<circle cx="${20 + i * 16}" cy="${chrome / 2}" r="5" fill="${TERM.light}"/>`)
    .join("");
  d.body += d.text(W / 2, chrome / 2 + 4, "boxd-turbo run · a real run on vercel/ai, at its real speed", {
    font: "mono",
    size: 11,
    fill: TERM.dim,
    anchor: "middle",
  });
  const pct = (sec: number) => (sec / loop) * 100;
  lines.forEach((l, i) => {
    const p = pct(l.at);
    d.css += `.l${i}{animation:a${i} ${loop.toFixed(1)}s linear infinite}@keyframes a${i}{0%,${p.toFixed(2)}%{opacity:0}${(p + 0.01).toFixed(2)}%,100%{opacity:1}}`;
    d.body += d.spans(24, top + i * lh, l.parts, { size: 13, cls: `l${i}` });
  });
  // The cursor: the notched box, 10 px, stretched upright, blinking after the last prompt.
  const cy = top + (lines.length - 1) * lh;
  const p = pct(end);
  d.css += `.cur{animation:cur ${loop.toFixed(1)}s steps(1) infinite}@keyframes cur{0%,${p.toFixed(2)}%{opacity:0}${(p + 0.01).toFixed(2)}%{opacity:1}}.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}`;
  d.css += "@media (prefers-reduced-motion: reduce){text,.cur,.blink{animation:none!important}}";
  d.body += `<g class="cur"><g class="blink" transform="translate(${24 + monoWidth("$ ", 13)},${cy - 11}) scale(1,1.2)"><path d="${notched(0, 0, 9, 9, 0.75, 1.8, 0.75)}" fill="${TERM.prompt}"/></g></g>`;
  return d.render();
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────────

mkdirSync(assets, { recursive: true });
const boxd = boxdMedians();
const exp = experiment();
const vercel = exp.lanes["vercel-ci"] as Record<string, { median_s: number; usd_per_run: number }>;
const runFile = JSON.parse(readFileSync(join(results, "core-run.json"), "utf8")) as RunFile;
const ran = runFile.results.filter((r) => r.status === "ran").length;
const longest = runFile.results.reduce((a, b) => (b.seconds > a.seconds ? b : a));
const ownScale = "Each change on its own scale: the slower platform fills the track.";
const vParts = vercelParts();
const bParts = boxdParts();
console.log("where the time goes", JSON.stringify({ vercel: vParts, boxd: bParts }));

for (const t of THEMES) {
  writeFileSync(
    join(assets, `race-${t.name}.svg`),
    await comparison(t, {
      kicker: "boxd-turbo vs Vercel CI",
      title: "Push to green on vercel/ai",
      subtitle: "Median of 3 pushes each, from git push to the result on GitHub. Same commit, same tasks.",
      value: (lane, s) => (lane === "boxd" ? (boxd[s]?.median ?? 0) : (vercel[s]?.median_s ?? 0)),
      fmt: secs,
      notes: [
        "Every package's type-check and test with their builds, 249 tasks, tagged ci the Vercel CI way.",
        `${ownScale} Raw runs in bench/results.`,
      ],
      better: "faster",
    }),
  );
  writeFileSync(
    join(assets, `cost-${t.name}.svg`),
    await comparison(t, {
      kicker: "boxd-turbo vs Vercel CI",
      title: "What one run costs",
      subtitle: "Median per push, at list prices. boxd: every machine while it was up, the server until it sleeps.",
      value: (lane, s) => (lane === "boxd" ? (boxd[s]?.usd ?? 0) : (vercel[s]?.usd_per_run ?? 0)),
      fmt: money,
      notes: [
        "Vercel CI: $0.0035 per CPU-minute. boxd: $0.047 per vCPU-hour and $0.014 per GiB-hour, all RAM in use.",
        ownScale,
      ],
      better: "cheaper",
    }),
  );
  writeFileSync(
    join(assets, `timeline-${t.name}.svg`),
    await timeline(t, runFile, {
      kicker: "boxd-turbo, one real run",
      title: "A core change, task by task",
      subtitle: `${ran} tasks on ${runFile.machines} machines, each starting when its dependencies were done.`,
      notes: [
        "Each row is a machine restored from the snapshot, and each bar is one Turborepo task.",
        `The long bar is ${longest.id}, ${secs(longest.seconds)}. Times from the run's start.`,
      ],
    }),
  );
  writeFileSync(join(assets, `time-${t.name}.svg`), await whereTimeGoes(t, vParts, bParts));
  writeFileSync(join(assets, `how-${t.name}.svg`), await howItWorks(t));
  // The terminal looks the same in both modes, as on the site.
  writeFileSync(join(assets, `demo-${t.name}.svg`), await demo(readFileSync(join(results, "demo-run.txt"), "utf8")));
}
// The README's table, from the same numbers as the charts.

const rows = SCENARIOS.map((s) => {
  const b = boxd[s.key] as { median: number; usd: number };
  const v = vercel[s.key] as { median_s: number; usd_per_run: number };
  const r = v.median_s / b.median;
  return `| ${s.label} | **${secs(b.median)}** | ${secs(v.median_s)} | ${r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× slower`} | ${money(b.usd)} | ${money(v.usd_per_run)} |`;
});
writeFileSync(
  join(results, "summary.md"),
  [
    "| Push to green on vercel/ai | boxd-turbo | Vercel CI | | Cost, boxd-turbo | Cost, Vercel CI |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
console.log("boxd medians", JSON.stringify(boxd));
console.log("wrote assets/{race,cost,time,timeline,how,demo}-{light,dark}.svg and bench/results/summary.md");
