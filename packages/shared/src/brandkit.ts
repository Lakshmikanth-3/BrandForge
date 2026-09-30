/**
 * Deterministic brand-kit generator.
 *
 * This is the product. A caller sends a short brief — a name, an industry, a few
 * vibe words — and gets back a complete, self-consistent brand kit: a colour
 * palette with named roles, a Google-Fonts pairing, brand-voice adjectives, a set
 * of taglines, and paste-ready CSS custom properties.
 *
 * Two properties are load-bearing and are the reason this lives in `shared`:
 *
 *  1. It is PURE and DETERMINISTIC. The same brief always produces the same kit,
 *     with no clock, no randomness source, and no network. That is what lets the
 *     browser render a live preview and the paid API return the identical bytes —
 *     one algorithm, two callers, no drift. It is also what makes it testable.
 *  2. It has NO node or browser dependencies. It is imported by the Hono API
 *     (node) and by the Vite frontend (browser) from the same file, so anything
 *     it touches has to exist in both. It touches nothing but arithmetic.
 *
 * The generation is not "random colours". A seed is derived from the brief, the
 * vibe words steer hue family / saturation / colour scheme / typography, and the
 * palette is built with basic colour theory (complementary / analogous / triadic)
 * so the three brand colours actually relate to each other.
 */

export interface BrandBrief {
  /** The brand name. Required — everything else is optional. */
  name: string;
  /** Free text, e.g. "fintech", "specialty coffee", "childcare". */
  industry?: string;
  /** Vibe words, e.g. ["modern", "bold"]. Unknown words are ignored for styling but still seed the kit. */
  vibe?: string[];
}

export interface Swatch {
  /** Where this colour is meant to be used. */
  role: "primary" | "secondary" | "accent" | "dark" | "light" | "muted";
  hex: string;
  /** Black or white, whichever stays readable on top of this colour. */
  textOn: string;
}

export interface FontSpec {
  family: string;
  /** Google Fonts category, for the "why" of the pairing. */
  category: "sans-serif" | "serif" | "display" | "monospace";
  weights: number[];
}

export interface FontPairing {
  heading: FontSpec;
  body: FontSpec;
  /** A single <link href> that loads exactly the families and weights used. */
  googleFontsUrl: string;
  /** One line explaining why these two go together, for the kit's rationale. */
  rationale: string;
}

export interface BrandKit {
  name: string;
  brief: BrandBrief;
  /** The 32-bit seed the whole kit derives from. Surfaced so a result is reproducible. */
  seed: number;
  /** Vibe words that were recognised and actually influenced the styling. */
  matchedVibes: string[];
  scheme: ColourScheme;
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    dark: string;
    light: string;
    muted: string;
  };
  /** The same colours as an ordered, role-tagged list — what a UI iterates over. */
  swatches: Swatch[];
  fonts: FontPairing;
  /** The chosen headline tagline. */
  tagline: string;
  /** A few alternatives, the first of which is `tagline`. */
  taglines: string[];
  /** Brand-voice adjectives. */
  voice: string[];
  /** Paste-ready `:root { … }` with colour and font custom properties. */
  cssVariables: string;

  /* ---- v2: the full brand kit (additive; every field above still works) ---- */
  meta: KitMeta;
  strategy: Strategy;
  logo: LogoSet;
  colors: ColorSystem;
  typography: TypographySystem;
  visual: VisualLanguage;
  imagery: Imagery;
  ui: UISystem;
  /** Rich voice guidance (the flat `voice` array above stays as the trait words). */
  voiceKit: VoiceKit;
  social: Social;
  marketing: Marketing;
  guidelines: Guidelines;
  exports: KitExports;
}

type ColourScheme = "complementary" | "analogous" | "triadic";

/* ------------------------------------------------------------------ *
 * v2 kit types
 * ------------------------------------------------------------------ */

export interface KitMeta {
  name: string;
  slug: string;
  industry: string;
  vibes: string[];
  seed: number;
  version: "2.0";
}

export interface StrategyValue {
  title: string;
  line: string;
}
export interface PersonalityTrait {
  trait: string;
  is: string;
  isNot: string;
}
export interface Positioning {
  forWho: string;
  category: string;
  benefit: string;
  unlike: string;
  statement: string;
}
export interface Strategy {
  mission: string;
  vision: string;
  values: StrategyValue[];
  personality: PersonalityTrait[];
  positioning: Positioning;
}

/** A colour with everything a designer needs to use it. */
export interface DetailedSwatch {
  hex: string;
  rgb: string;
  hsl: string;
  /** Readable foreground (black/white) for text on this colour. */
  text: string;
  usage: string;
}

export type RampStep =
  | "50" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";
export type Ramp = Record<RampStep, string>;

export interface ContrastRow {
  fg: string;
  bg: string;
  ratio: number;
  pass: "AAA" | "AA" | "AA-large" | "fail";
}

export interface ColorSystem {
  primary: DetailedSwatch;
  secondary: DetailedSwatch;
  accent: DetailedSwatch;
  background: { light: DetailedSwatch; dark: DetailedSwatch; muted: DetailedSwatch };
  ramps: Record<"primary" | "secondary" | "accent" | "neutral", Ramp>;
  ratios: ContrastRow[];
}

export interface ScaleRow {
  token:
    | "display" | "h1" | "h2" | "h3" | "h4"
    | "body-lg" | "body" | "small" | "caption";
  px: number;
  rem: string;
  lineHeight: number;
  weight: number;
  tracking: string;
  font: "heading" | "body";
}
export interface TypeFace {
  family: string;
  weights: number[];
  fallback: string;
  link: string;
}
export interface TypographySystem {
  headings: TypeFace;
  body: TypeFace;
  scale: ScaleRow[];
  ratio: number;
}

export interface LogoSet {
  /** Horizontal lockup: mark + wordmark. SVG string. */
  primary: string;
  /** Stacked lockup: mark above wordmark. SVG string. */
  secondary: string;
  /** Mark only, square. SVG string. */
  icon: string;
}

export interface KitExports {
  cssVariables: string;
  tailwind: string;
  json: string;
  figmaTokens: string;
}

/* ---- 05 Visual language ---- */
export interface IconSample {
  name: string;
  svg: string;
}
export interface GradientDef {
  name: string;
  css: string;
}
export interface PatternDef {
  name: string;
  svg: string;
  css: string;
}
export interface VisualLanguage {
  icons: {
    style: "outline" | "filled" | "duotone";
    stroke: number;
    corner: "round" | "square";
    grid: 24;
    samples: IconSample[];
  };
  shapes: { radius: { sm: number; md: number; lg: number; pill: number }; motif: string; svg: string };
  gradients: GradientDef[];
  patterns: PatternDef[];
  effects: {
    shadow: { sm: string; md: string; lg: string };
    blur: string;
    border: string;
    motion: { duration: string; easing: string };
  };
}

/* ---- 06 Imagery ---- */
export interface Imagery {
  photography: { mood: string; subjects: string[]; lighting: string; composition: string; avoid: string[] };
  illustration: { style: string; lineWeight: string; palette: string[]; do: string[]; dont: string[] };
  treatment: { name: string; cssFilter: string; overlay: string; radius: number; notes: string };
}

/* ---- 07 UI system ---- */
export type CssObject = Record<string, string>;
export interface UIButtonSpec {
  variant: "primary" | "secondary" | "ghost" | "destructive";
  css: CssObject;
  hover: CssObject;
}
export interface UISystem {
  buttons: UIButtonSpec[];
  cards: { css: CssObject };
  inputs: { css: CssObject; focus: CssObject; error: CssObject };
  navigation: { css: CssObject; active: CssObject };
  components: { name: "badge" | "alert" | "toggle" | "tabs" | "avatar"; css: CssObject }[];
}

/* ---- 08 Voice (rich) ---- */
export interface ToneRow {
  context: "marketing" | "product" | "support" | "error";
  description: string;
  example: string;
}
export interface VoiceKit {
  tone: ToneRow[];
  wordsToUse: string[];
  wordsToAvoid: string[];
  boilerplate: { short: string; long: string };
}

/* ---- 09 Social ---- */
export interface SocialTemplate {
  platform: "instagram-post" | "instagram-story" | "x-post" | "linkedin-banner";
  width: number;
  height: number;
  layout: "headline" | "quote" | "announcement";
  html: string;
}
export interface Social {
  handle: string;
  bio: string;
  hashtags: string[];
  cadence: string;
  templates: SocialTemplate[];
}

/* ---- 10 Marketing ---- */
export interface Marketing {
  businessCard: { front: string; back: string };
  letterhead: string;
  emailSignature: string;
  onePager: string;
  presentationCover: string;
}

/* ---- 11 Guidelines ---- */
export interface DoDont {
  do: string;
  dont: string;
}
export interface Guidelines {
  summary: string;
  sections: { id: string; title: string; page: number }[];
  doDont: DoDont[];
  html: string;
}

/* ------------------------------------------------------------------ *
 * Seed + deterministic PRNG
 * ------------------------------------------------------------------ */

/**
 * FNV-1a, 32-bit. A small, well-behaved string hash — we are not hashing for
 * security, only for a stable spread of briefs across the seed space.
 */
export function seedFromBrief(brief: BrandBrief): number {
  const basis = [
    brief.name.trim().toLowerCase(),
    (brief.industry ?? "").trim().toLowerCase(),
    // Order-independent: sorting the vibe words means ["bold","modern"] and
    // ["modern","bold"] describe the same brand and get the same kit.
    (brief.vibe ?? [])
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0)
      .sort()
      .join(","),
  ].join("|");

  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit int; Math.imul does the 32-bit multiply.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 — a tiny deterministic PRNG. Same seed, same stream, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Colour maths (HSL → hex, readable text colour)
 * ------------------------------------------------------------------ */

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const lit = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lit - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const to255 = (v: number) => Math.round((v + m) * 255);
  return `#${[to255(r), to255(g), to255(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, used only to decide black-vs-white overlay text. */
function readableTextOn(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "#0b0b0f" : "#ffffff";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ *
 * Vibe catalogue
 * ------------------------------------------------------------------ */

interface VibeProfile {
  /** Preferred hue window; the seed picks a point inside it. */
  hue: [number, number];
  saturation: number;
  scheme: ColourScheme;
  /** Tags used to score the font pairings. */
  fontTags: string[];
  voice: string[];
  adjectives: string[];
}

/**
 * Canonical vibe profiles. Aliases (below) fold synonyms onto these so
 * "sleek" and "modern" and "clean" do not each need their own entry.
 */
const VIBES: Record<string, VibeProfile> = {
  modern: {
    hue: [200, 232],
    saturation: 72,
    scheme: "complementary",
    fontTags: ["geometric", "sans"],
    voice: ["clear", "confident"],
    adjectives: ["modern", "sharp"],
  },
  minimal: {
    hue: [198, 220],
    saturation: 30,
    scheme: "analogous",
    fontTags: ["sans", "neutral"],
    voice: ["calm", "precise"],
    adjectives: ["essential", "quiet"],
  },
  bold: {
    hue: [352, 385],
    saturation: 85,
    scheme: "complementary",
    fontTags: ["display", "sans"],
    voice: ["fearless", "direct"],
    adjectives: ["bold", "unstoppable"],
  },
  playful: {
    hue: [28, 58],
    saturation: 82,
    scheme: "triadic",
    fontTags: ["rounded", "friendly"],
    voice: ["friendly", "upbeat"],
    adjectives: ["playful", "bright"],
  },
  luxury: {
    hue: [268, 320],
    saturation: 42,
    scheme: "analogous",
    fontTags: ["serif", "elegant"],
    voice: ["refined", "assured"],
    adjectives: ["timeless", "refined"],
  },
  warm: {
    hue: [18, 44],
    saturation: 58,
    scheme: "analogous",
    fontTags: ["serif", "humanist"],
    voice: ["grounded", "honest"],
    adjectives: ["warm", "natural"],
  },
  corporate: {
    hue: [210, 226],
    saturation: 54,
    scheme: "complementary",
    fontTags: ["sans", "neutral"],
    voice: ["trusted", "reliable"],
    adjectives: ["reliable", "proven"],
  },
  creative: {
    hue: [280, 340],
    saturation: 78,
    scheme: "triadic",
    fontTags: ["display", "elegant"],
    voice: ["original", "expressive"],
    adjectives: ["original", "vivid"],
  },
  calm: {
    hue: [150, 190],
    saturation: 38,
    scheme: "analogous",
    fontTags: ["sans", "humanist"],
    voice: ["calm", "measured"],
    adjectives: ["calm", "clear"],
  },
  energetic: {
    hue: [8, 34],
    saturation: 88,
    scheme: "triadic",
    fontTags: ["display", "sans"],
    voice: ["energetic", "driven"],
    adjectives: ["energetic", "fast"],
  },
};

/** Synonyms → canonical vibe key. Keeps the catalogue small without being brittle. */
const VIBE_ALIASES: Record<string, string> = {
  sleek: "modern",
  clean: "modern",
  tech: "modern",
  futuristic: "modern",
  simple: "minimal",
  understated: "minimal",
  strong: "bold",
  loud: "bold",
  fun: "playful",
  quirky: "playful",
  friendly: "playful",
  premium: "luxury",
  elegant: "luxury",
  luxe: "luxury",
  sophisticated: "luxury",
  earthy: "warm",
  organic: "warm",
  natural: "warm",
  rustic: "warm",
  professional: "corporate",
  trustworthy: "corporate",
  serious: "corporate",
  artistic: "creative",
  vibrant: "creative",
  serene: "calm",
  soft: "calm",
  fresh: "calm",
  dynamic: "energetic",
  active: "energetic",
};

function resolveVibes(vibe: string[] | undefined): { keys: string[]; profiles: VibeProfile[] } {
  const keys: string[] = [];
  for (const raw of vibe ?? []) {
    const word = raw.trim().toLowerCase();
    if (word.length === 0) continue;
    const key = VIBES[word] ? word : VIBE_ALIASES[word];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return { keys, profiles: keys.map((k) => VIBES[k]!) };
}

/* ------------------------------------------------------------------ *
 * Typography catalogue
 * ------------------------------------------------------------------ */

interface Pairing {
  heading: FontSpec;
  body: FontSpec;
  tags: string[];
  rationale: string;
}

const PAIRINGS: Pairing[] = [
  {
    heading: { family: "Space Grotesk", category: "sans-serif", weights: [500, 700] },
    body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
    tags: ["geometric", "sans", "neutral"],
    rationale: "A geometric display sans over a neutral workhorse — modern without shouting.",
  },
  {
    heading: { family: "Poppins", category: "sans-serif", weights: [600, 700] },
    body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
    tags: ["rounded", "friendly", "sans"],
    rationale: "Rounded geometric caps stay approachable; Inter keeps long copy readable.",
  },
  {
    heading: { family: "Playfair Display", category: "serif", weights: [600, 700] },
    body: { family: "Source Sans 3", category: "sans-serif", weights: [400, 600] },
    tags: ["serif", "elegant"],
    rationale: "High-contrast serif headlines against a calm sans — editorial and premium.",
  },
  {
    heading: { family: "Fraunces", category: "serif", weights: [500, 700] },
    body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
    tags: ["serif", "humanist", "elegant"],
    rationale: "A soft, old-style serif with warmth, grounded by a clean sans for the body.",
  },
  {
    heading: { family: "Archivo", category: "sans-serif", weights: [700, 800] },
    body: { family: "Roboto", category: "sans-serif", weights: [400, 500] },
    tags: ["display", "sans", "bold"],
    rationale: "Heavy grotesque headlines carry impact; Roboto stays quiet underneath.",
  },
  {
    heading: { family: "Sora", category: "sans-serif", weights: [600, 700] },
    body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
    tags: ["geometric", "sans", "neutral"],
    rationale: "A precise geometric sans pairing that reads as engineered and current.",
  },
  {
    heading: { family: "DM Serif Display", category: "serif", weights: [400] },
    body: { family: "DM Sans", category: "sans-serif", weights: [400, 500] },
    tags: ["serif", "elegant", "display"],
    rationale: "A dramatic display serif with its matching sans — expressive but cohesive.",
  },
  {
    heading: { family: "Work Sans", category: "sans-serif", weights: [600, 700] },
    body: { family: "Lora", category: "serif", weights: [400, 500] },
    tags: ["humanist", "serif", "sans"],
    rationale: "A humanist sans over a readable serif body — warm, literary, trustworthy.",
  },
  {
    heading: { family: "Chivo", category: "sans-serif", weights: [700] },
    body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
    tags: ["sans", "neutral", "corporate"],
    rationale: "A no-nonsense grotesque for headers with a neutral body — steady and professional.",
  },
  {
    heading: { family: "Nunito", category: "sans-serif", weights: [700, 800] },
    body: { family: "Nunito Sans", category: "sans-serif", weights: [400, 600] },
    tags: ["rounded", "friendly", "sans"],
    rationale: "Fully rounded terminals across the family — soft, cheerful, and cohesive.",
  },
];

function googleFontsUrl(fonts: FontSpec[]): string {
  const families = fonts
    .map((f) => `family=${f.family.replace(/ /g, "+")}:wght@${[...f.weights].sort((a, b) => a - b).join(";")}`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/**
 * Scores each pairing against the union of the matched vibes' font tags and picks
 * the best, breaking ties with the seed so the choice is stable but not always the
 * first row. With no recognised vibe the seed alone chooses.
 */
function choosePairing(profiles: VibeProfile[], rand: () => number): Pairing {
  const wanted = new Set(profiles.flatMap((p) => p.fontTags));
  let best: Pairing[] = [];
  let bestScore = -1;
  for (const pairing of PAIRINGS) {
    const score = pairing.tags.reduce((n, tag) => n + (wanted.has(tag) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = [pairing];
    } else if (score === bestScore) {
      best.push(pairing);
    }
  }
  return best[Math.floor(rand() * best.length)] ?? PAIRINGS[0]!;
}

/* ------------------------------------------------------------------ *
 * Taglines + voice
 * ------------------------------------------------------------------ */

function buildTaglines(brief: BrandBrief, adjectives: string[], rand: () => number): string[] {
  const name = brief.name.trim();
  const industry = (brief.industry ?? "").trim();
  const [a1, a2] = [adjectives[0] ?? "bold", adjectives[1] ?? "modern"];
  const cap = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

  const templates = [
    `${name}. ${cap(a1)} by design.`,
    industry ? `Where ${industry} meets ${a1}.` : `Made ${a1}, built to last.`,
    `${cap(a1)}. ${cap(a2)}. ${name}.`,
    industry ? `${cap(industry)}, done ${a1}ly.` : `Do it ${a1}. Do it once.`,
    `Meet ${name} — ${a1} from the first pixel.`,
  ];

  // Deterministic shuffle so the headline varies with the brief without being random.
  const pool = [...templates];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, 3);
}

/* ------------------------------------------------------------------ *
 * The generator
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * v2 colour helpers (hex → rgb/hsl, contrast, ramps)
 * ------------------------------------------------------------------ */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function rgbString(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}
function hslString(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function relLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function passRating(ratio: number): ContrastRow["pass"] {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "fail";
}

const RAMP_LIGHTNESS: Record<RampStep, number> = {
  "50": 96, "100": 91, "200": 83, "300": 73, "400": 63,
  "500": 52, "600": 44, "700": 35, "800": 25, "900": 15,
};

/** A 50→900 tint/shade ramp holding the base hue. */
function rampFromHex(hex: string, opts: { neutral?: boolean } = {}): Ramp {
  const { h, s } = hexToHsl(hex);
  const sat = opts.neutral ? Math.min(s, 10) : s;
  const out = {} as Ramp;
  for (const step of Object.keys(RAMP_LIGHTNESS) as RampStep[]) {
    // Ease saturation down at the extremes so 50/900 do not look muddy.
    const l = RAMP_LIGHTNESS[step];
    const edge = l > 88 || l < 20 ? sat * 0.7 : sat;
    out[step] = hslToHex(h, edge, l);
  }
  return out;
}

function detailedSwatch(hex: string, usage: string): DetailedSwatch {
  return { hex, rgb: rgbString(hex), hsl: hslString(hex), text: readableTextOn(hex), usage };
}

/* ------------------------------------------------------------------ *
 * v2 content builders (deterministic)
 * ------------------------------------------------------------------ */

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "brand"
  );
}

function audienceFor(industry: string): string {
  const key = industry.trim().toLowerCase();
  if (!key) return "ambitious teams";
  const map: Record<string, string> = {
    fintech: "finance teams",
    coffee: "everyday regulars",
    "specialty coffee": "everyday regulars",
    childcare: "busy parents",
    saas: "product teams",
    health: "people who care about their health",
    fitness: "people chasing their goals",
    education: "curious learners",
    ecommerce: "online shoppers",
  };
  return map[key] ?? `${key} customers`;
}

function outcomeFor(industry: string): string {
  const key = industry.trim().toLowerCase();
  const map: Record<string, string> = {
    fintech: "move money with confidence",
    "specialty coffee": "start the day well",
    coffee: "start the day well",
    childcare: "feel their kids are in good hands",
    saas: "ship faster",
    health: "take charge of their wellbeing",
    fitness: "show up and get stronger",
    education: "learn something that sticks",
    ecommerce: "find exactly what they want",
  };
  return map[key] ?? "get where they are going";
}

const IS_ISNOT: Record<string, { is: string; isNot: string }> = {
  modern: { is: "current and precise", isNot: "trendy or throwaway" },
  bold: { is: "direct and confident", isNot: "loud or reckless" },
  playful: { is: "warm and human", isNot: "silly or unserious" },
  luxury: { is: "refined and considered", isNot: "flashy or exclusionary" },
  minimal: { is: "clear and unhurried", isNot: "cold or empty" },
  corporate: { is: "dependable and steady", isNot: "stiff or faceless" },
  creative: { is: "original and expressive", isNot: "chaotic or self-indulgent" },
  warm: { is: "grounded and honest", isNot: "sentimental or vague" },
  calm: { is: "measured and reassuring", isNot: "passive or dull" },
  energetic: { is: "driven and quick", isNot: "frantic or careless" },
};

function buildStrategy(
  brief: BrandBrief,
  matched: string[],
  adjectives: string[],
  rand: () => number,
): Strategy {
  const name = brief.name;
  const industry = (brief.industry ?? "").trim();
  const audience = audienceFor(industry);
  const outcome = outcomeFor(industry);
  const cap = (s: string) => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);
  const category = industry ? `${industry} brand` : "brand";

  const valuePool: StrategyValue[] = [
    { title: "Clarity", line: "Say the true thing simply. No jargon, no noise." },
    { title: "Craft", line: "Sweat the details others skip — they add up." },
    { title: "Trust", line: "Do what we said we would, every time." },
    { title: "Momentum", line: "Ship, learn, improve — keep moving." },
    { title: "Warmth", line: "Treat people like people, not tickets." },
    { title: "Boldness", line: "Make the confident choice, then stand behind it." },
    { title: "Care", line: "Design for the person on the other end." },
  ];
  // Deterministic shuffle → take 3.
  const pool = [...valuePool];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const values = pool.slice(0, 3);

  const traitWords = (matched.length > 0 ? matched : ["modern", "bold"]).slice(0, 3);
  const personality: PersonalityTrait[] = traitWords.map((t) => {
    const pair = IS_ISNOT[t] ?? { is: "clear and confident", isNot: "vague or timid" };
    return { trait: cap(t), is: pair.is, isNot: pair.isNot };
  });

  const benefit = `helps ${audience} ${outcome}`;
  const positioning: Positioning = {
    forWho: audience,
    category,
    benefit,
    unlike: "the generic alternatives",
    statement: `For ${audience}, ${name} is the ${category} that ${benefit}. Unlike the generic alternatives, we do it ${adjectives[0] ?? "boldly"} and mean it.`,
  };

  return {
    mission: `${name} helps ${audience} ${outcome}.`,
    vision: `A world where ${audience} never settle for ${adjectives[1] ?? "bland"}, forgettable ${category}s.`,
    values,
    personality,
    positioning,
  };
}

const TYPE_RATIO: Record<string, number> = {
  minimal: 1.2,
  modern: 1.25,
  corporate: 1.25,
  calm: 1.2,
  bold: 1.333,
  energetic: 1.333,
  playful: 1.25,
  luxury: 1.414,
  creative: 1.333,
  warm: 1.2,
};

function buildTypeScale(ratio: number): ScaleRow[] {
  const base = 16;
  const rows: { token: ScaleRow["token"]; n: number; font: ScaleRow["font"]; weight: number; lh: number }[] = [
    { token: "display", n: 5, font: "heading", weight: 700, lh: 1.02 },
    { token: "h1", n: 4, font: "heading", weight: 700, lh: 1.08 },
    { token: "h2", n: 3, font: "heading", weight: 600, lh: 1.15 },
    { token: "h3", n: 2, font: "heading", weight: 600, lh: 1.2 },
    { token: "h4", n: 1, font: "heading", weight: 600, lh: 1.3 },
    { token: "body-lg", n: 0.5, font: "body", weight: 400, lh: 1.6 },
    { token: "body", n: 0, font: "body", weight: 400, lh: 1.6 },
    { token: "small", n: -1, font: "body", weight: 400, lh: 1.5 },
    { token: "caption", n: -2, font: "body", weight: 500, lh: 1.4 },
  ];
  return rows.map((r) => {
    const px = Math.round(base * ratio ** r.n);
    return {
      token: r.token,
      px,
      rem: `${(px / 16).toFixed(3).replace(/\.?0+$/, "")}rem`,
      lineHeight: r.lh,
      weight: r.weight,
      tracking: r.n >= 4 ? "-0.02em" : r.n >= 1 ? "-0.01em" : "0",
      font: r.font,
    };
  });
}

const MOTIF_BY_VIBE: Record<string, "circle" | "roundsquare" | "square" | "arc"> = {
  playful: "circle",
  warm: "circle",
  calm: "circle",
  luxury: "arc",
  creative: "arc",
  bold: "square",
  energetic: "square",
  modern: "roundsquare",
  minimal: "roundsquare",
  corporate: "roundsquare",
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "B";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Deterministic SVG logo: initials inside the vibe's motif, plus a wordmark. */
function buildLogo(
  brief: BrandBrief,
  palette: BrandKit["palette"],
  fonts: FontPairing,
  swatches: Swatch[],
  motif: "circle" | "roundsquare" | "square" | "arc",
): LogoSet {
  const mark = initials(brief.name);
  const onPrimary = swatches.find((s) => s.role === "primary")?.textOn ?? "#ffffff";
  const headFamily = `'${fonts.heading.family}', ${fonts.heading.category}`;

  const shape = (size: number): string => {
    if (motif === "circle") return `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${palette.primary}"/>`;
    if (motif === "square") return `<rect width="${size}" height="${size}" fill="${palette.primary}"/>`;
    if (motif === "arc")
      return `<path d="M0 ${size} A ${size} ${size} 0 0 1 ${size} 0 L ${size} ${size} Z" fill="${palette.primary}"/><rect width="${size}" height="${size}" rx="${size * 0.16}" fill="none"/>`;
    return `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${palette.primary}"/>`;
  };

  const markSvg = (size: number): string =>
    `${shape(size)}<text x="${size / 2}" y="${size / 2}" dominant-baseline="central" text-anchor="middle" font-family="${headFamily}" font-weight="700" font-size="${size * 0.5}" fill="${onPrimary}">${mark}</text>`;

  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="${brief.name} icon"><g>${markSvg(120)}</g></svg>`;

  const wordmark = (x: number, y: number, size: number): string =>
    `<text x="${x}" y="${y}" dominant-baseline="central" font-family="${headFamily}" font-weight="700" font-size="${size}" letter-spacing="-0.02em" fill="${palette.dark}">${escapeXml(brief.name)}</text>`;

  const primary = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 120" width="520" height="120" role="img" aria-label="${brief.name} logo"><g>${markSvg(120)}</g>${wordmark(150, 62, 56)}</svg>`;

  const secondary = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 210" width="260" height="210" role="img" aria-label="${brief.name} stacked logo"><g transform="translate(70,0)">${markSvg(120)}</g><text x="130" y="175" text-anchor="middle" font-family="${headFamily}" font-weight="700" font-size="44" letter-spacing="-0.02em" fill="${palette.dark}">${escapeXml(brief.name)}</text></svg>`;

  return { primary, secondary, icon };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

function buildExports(
  cssVariables: string,
  colors: ColorSystem,
  fonts: FontPairing,
  meta: KitMeta,
): KitExports {
  const tailwind = [
    "/** @type {import('tailwindcss').Config} */",
    "module.exports = {",
    "  theme: {",
    "    extend: {",
    "      colors: {",
    `        primary: ${JSON.stringify(colors.ramps.primary, null, 10).replace(/\n/g, "\n      ")},`,
    `        secondary: ${JSON.stringify(colors.ramps.secondary)},`,
    `        accent: ${JSON.stringify(colors.ramps.accent)},`,
    "      },",
    "      fontFamily: {",
    `        heading: ['${fonts.heading.family}', '${fonts.heading.category}'],`,
    `        body: ['${fonts.body.family}', '${fonts.body.category}'],`,
    "      },",
    "    },",
    "  },",
    "};",
  ].join("\n");

  const figmaTokens = JSON.stringify(
    {
      $schema: "https://schemas.figma.com/tokens",
      color: {
        primary: { $value: colors.primary.hex, $type: "color" },
        secondary: { $value: colors.secondary.hex, $type: "color" },
        accent: { $value: colors.accent.hex, $type: "color" },
      },
      font: {
        heading: { $value: fonts.heading.family, $type: "fontFamily" },
        body: { $value: fonts.body.family, $type: "fontFamily" },
      },
    },
    null,
    2,
  );

  const json = JSON.stringify(
    { meta, colors: { primary: colors.primary.hex, secondary: colors.secondary.hex, accent: colors.accent.hex } },
    null,
    2,
  );

  return { cssVariables, tailwind, json, figmaTokens };
}

/* ------------------------------------------------------------------ *
 * v2 section builders 05–11 (deterministic)
 * ------------------------------------------------------------------ */

const ICON_PATHS: { name: string; d: string }[] = [
  { name: "arrow", d: "M5 12h14M13 6l6 6-6 6" },
  { name: "check", d: "M4 12l5 5L20 6" },
  { name: "bolt", d: "M13 3L4 14h6l-1 7 9-11h-6z" },
  { name: "star", d: "M12 3l2.7 5.5 6 .9-4.3 4.2 1 6L12 17l-5.4 2.6 1-6L3.3 9.4l6-.9z" },
  { name: "heart", d: "M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9z" },
  { name: "globe", d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" },
  { name: "chart", d: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { name: "shield", d: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
];

const RADII_BY_VIBE: Record<string, { sm: number; md: number; lg: number; pill: number }> = {
  playful: { sm: 10, md: 18, lg: 28, pill: 999 },
  warm: { sm: 8, md: 14, lg: 22, pill: 999 },
  luxury: { sm: 2, md: 4, lg: 8, pill: 999 },
  minimal: { sm: 4, md: 8, lg: 12, pill: 999 },
  bold: { sm: 4, md: 8, lg: 14, pill: 999 },
  modern: { sm: 6, md: 10, lg: 16, pill: 999 },
  corporate: { sm: 4, md: 8, lg: 12, pill: 999 },
  creative: { sm: 10, md: 16, lg: 24, pill: 999 },
  calm: { sm: 8, md: 14, lg: 20, pill: 999 },
  energetic: { sm: 4, md: 8, lg: 14, pill: 999 },
};

function buildVisual(
  palette: BrandKit["palette"],
  colors: ColorSystem,
  leadVibe: string,
): VisualLanguage {
  const style: VisualLanguage["icons"]["style"] =
    leadVibe === "playful" ? "duotone" : leadVibe === "bold" ? "filled" : "outline";
  const stroke = leadVibe === "luxury" ? 1.25 : leadVibe === "bold" ? 2.25 : 1.75;
  const corner: "round" | "square" = leadVibe === "bold" || leadVibe === "energetic" ? "square" : "round";

  const samples: IconSample[] = ICON_PATHS.map((ic) => ({
    name: ic.name,
    svg:
      style === "filled"
        ? `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${ic.d}" fill="none" stroke="${palette.primary}" stroke-width="${stroke}" stroke-linecap="${corner}" stroke-linejoin="${corner}"/></svg>`
        : `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${ic.d}" fill="none" stroke="${palette.primary}" stroke-width="${stroke}" stroke-linecap="${corner}" stroke-linejoin="${corner}"/></svg>`,
  }));

  const radius = RADII_BY_VIBE[leadVibe] ?? RADII_BY_VIBE["modern"]!;
  const motif = MOTIF_BY_VIBE[leadVibe] ?? "roundsquare";
  const motifSvg = `<svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">${
    motif === "circle"
      ? `<circle cx="100" cy="100" r="90" fill="${palette.primary}"/>`
      : motif === "square"
        ? `<rect x="10" y="10" width="180" height="180" fill="${palette.primary}"/>`
        : motif === "arc"
          ? `<path d="M10 190 A 180 180 0 0 1 190 10 L 190 190 Z" fill="${palette.primary}"/>`
          : `<rect x="10" y="10" width="180" height="180" rx="40" fill="${palette.primary}"/>`
  }</svg>`;

  const gradients: GradientDef[] = [
    { name: "Brand", css: `linear-gradient(135deg, ${palette.primary}, ${palette.secondary})` },
    { name: "Glow", css: `radial-gradient(circle at 30% 30%, ${palette.accent}, transparent 70%)` },
    { name: "Deep", css: `linear-gradient(180deg, ${colors.ramps.primary["900"]}, ${colors.ramps.primary["600"]})` },
  ];

  const patterns: PatternDef[] = [
    {
      name: "Dots",
      svg: `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="2" fill="${palette.primary}"/></svg>`,
      css: `background-color: ${palette.light}; background-image: radial-gradient(${palette.primary} 2px, transparent 2px); background-size: 24px 24px;`,
    },
    {
      name: "Lines",
      svg: `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 24 L24 0" stroke="${palette.accent}" stroke-width="2"/></svg>`,
      css: `background: repeating-linear-gradient(45deg, ${palette.light}, ${palette.light} 10px, ${palette.muted} 10px, ${palette.muted} 12px);`,
    },
  ];

  return {
    icons: { style, stroke, corner, grid: 24, samples },
    shapes: { radius, motif, svg: motifSvg },
    gradients,
    patterns,
    effects: {
      shadow: {
        sm: "0 1px 2px rgba(0,0,0,0.08)",
        md: "0 4px 12px rgba(0,0,0,0.12)",
        lg: "0 12px 32px rgba(0,0,0,0.18)",
      },
      blur: "blur(12px)",
      border: `1px solid ${palette.muted}`,
      motion: { duration: leadVibe === "energetic" ? "150ms" : "240ms", easing: "cubic-bezier(0.22,1,0.36,1)" },
    },
  };
}

function buildImagery(industry: string, leadVibe: string): Imagery {
  const mood: Record<string, string> = {
    luxury: "restrained, editorial, high-contrast",
    playful: "bright, candid, full of life",
    bold: "punchy, high-energy, saturated",
    minimal: "clean, airy, lots of negative space",
    warm: "natural light, honest, human",
    modern: "crisp, confident, purposeful",
  };
  const filter: Record<string, string> = {
    warm: "sepia(0.15) saturate(1.1)",
    luxury: "contrast(1.05) saturate(0.85)",
    bold: "contrast(1.15) saturate(1.2)",
    minimal: "grayscale(0.2)",
  };
  return {
    photography: {
      mood: mood[leadVibe] ?? "clean and confident",
      subjects: [industry || "the product in use", "real people, not stock poses", "details and texture"],
      lighting: leadVibe === "luxury" ? "soft directional, deep shadows" : "bright, even, natural",
      composition: "generous negative space; subject off-centre on the grid",
      avoid: ["cheesy stock smiles", "busy backgrounds", "heavy filters that fight the palette"],
    },
    illustration: {
      style: leadVibe === "playful" ? "rounded, friendly, two-tone" : "geometric line work",
      lineWeight: leadVibe === "bold" ? "bold, 2.5px" : "medium, 1.75px",
      palette: ["primary", "accent", "neutral-300"],
      do: ["reuse the icon stroke and corners", "keep to brand colours"],
      dont: ["mix illustration styles", "add gradients that clash with the palette"],
    },
    treatment: {
      name: `${leadVibe} treatment`,
      cssFilter: filter[leadVibe] ?? "none",
      overlay: "primary at 12% opacity",
      radius: 12,
      notes: "Apply the same filter and radius to every hero image for consistency.",
    },
  };
}

function buildUI(palette: BrandKit["palette"], colors: ColorSystem, fonts: FontPairing, leadVibe: string): UISystem {
  const radius = `${(RADII_BY_VIBE[leadVibe] ?? RADII_BY_VIBE["modern"]!).md}px`;
  const onPrimary = colors.primary.text;
  const font = `'${fonts.body.family}', ${fonts.body.category}`;
  return {
    buttons: [
      {
        variant: "primary",
        css: { background: palette.primary, color: onPrimary, "border-radius": radius, padding: "10px 18px", "font-family": font, "font-weight": "600", border: "none" },
        hover: { background: colors.ramps.primary["600"] },
      },
      {
        variant: "secondary",
        css: { background: "transparent", color: palette.primary, border: `1px solid ${palette.primary}`, "border-radius": radius, padding: "10px 18px" },
        hover: { background: colors.ramps.primary["50"] },
      },
      {
        variant: "ghost",
        css: { background: "transparent", color: palette.dark, border: "none", "border-radius": radius, padding: "10px 18px" },
        hover: { background: colors.ramps.neutral["100"] },
      },
      {
        variant: "destructive",
        css: { background: "#e5484d", color: "#fff", "border-radius": radius, padding: "10px 18px", border: "none" },
        hover: { background: "#c93b40" },
      },
    ],
    cards: {
      css: { background: palette.light, border: `1px solid ${colors.ramps.neutral["200"]}`, "border-radius": radius, padding: "20px", "box-shadow": "0 4px 12px rgba(0,0,0,0.06)" },
    },
    inputs: {
      css: { background: "#fff", border: `1px solid ${colors.ramps.neutral["300"]}`, "border-radius": radius, padding: "10px 14px", "font-family": font },
      focus: { "border-color": palette.accent, "box-shadow": `0 0 0 3px ${palette.accent}33` },
      error: { "border-color": "#e5484d" },
    },
    navigation: {
      css: { display: "flex", gap: "8px", background: palette.light, padding: "8px", "border-radius": radius },
      active: { background: palette.primary, color: onPrimary },
    },
    components: [
      { name: "badge", css: { background: colors.ramps.accent["100"], color: colors.ramps.accent["800"], "border-radius": "999px", padding: "2px 10px", "font-size": "12px" } },
      { name: "alert", css: { background: colors.ramps.primary["50"], border: `1px solid ${colors.ramps.primary["200"]}`, "border-radius": radius, padding: "12px 16px" } },
      { name: "toggle", css: { background: palette.primary, "border-radius": "999px", width: "44px", height: "24px" } },
      { name: "tabs", css: { "border-bottom": `2px solid ${palette.primary}`, color: palette.primary } },
      { name: "avatar", css: { background: palette.primary, color: onPrimary, "border-radius": "999px", width: "40px", height: "40px" } },
    ],
  };
}

function buildVoiceKit(strategy: Strategy, adjectives: string[], leadVibe: string): VoiceKit {
  const a0 = adjectives[0] ?? "bold";
  const words: Record<string, { use: string[]; avoid: string[] }> = {
    luxury: { use: ["crafted", "considered", "timeless", "refined"], avoid: ["cheap", "hurry", "deal", "spam"] },
    playful: { use: ["let's", "hey", "fun", "easy"], avoid: ["synergy", "leverage", "utilise", "hereby"] },
    bold: { use: ["now", "own", "win", "no limits"], avoid: ["maybe", "kind of", "just", "try"] },
    corporate: { use: ["reliable", "proven", "secure", "trusted"], avoid: ["hack", "cheap", "whatever", "meh"] },
    minimal: { use: ["simple", "clear", "less", "focus"], avoid: ["revolutionary", "world-class", "cutting-edge"] },
  };
  const w = words[leadVibe] ?? { use: ["clear", "honest", "human", "confident"], avoid: ["synergy", "leverage", "disrupt", "world-class"] };
  return {
    tone: [
      { context: "marketing", description: `Confident and ${a0}. Lead with the benefit, keep sentences short.`, example: strategy.positioning.statement },
      { context: "product", description: "Plain and helpful. Tell people exactly what to do next.", example: "Add your first project to get started." },
      { context: "support", description: "Warm and patient. Own the problem, then fix it.", example: "That's on us — here's how we'll sort it out." },
      { context: "error", description: "Calm and specific. Say what happened and the way forward, no blame.", example: "That didn't go through. Check your connection and try again." },
    ],
    wordsToUse: w.use,
    wordsToAvoid: w.avoid,
    boilerplate: {
      short: `${strategy.mission}`,
      long: `${strategy.mission} ${strategy.vision} ${strategy.positioning.statement}`,
    },
  };
}

function buildSocial(meta: KitMeta, palette: BrandKit["palette"], colors: ColorSystem, fonts: FontPairing, taglines: string[]): Social {
  const handle = `@${meta.slug.replace(/-/g, "").slice(0, 15)}`;
  const head = `'${fonts.heading.family}', ${fonts.heading.category}`;
  const tag = taglines[0] ?? meta.name;
  const onPrimary = colors.primary.text;
  const card = (w: number, h: number, big: number) =>
    `<div style="width:${w}px;height:${h}px;background:${palette.primary};color:${onPrimary};display:flex;flex-direction:column;justify-content:center;padding:8%;box-sizing:border-box;font-family:${head}"><div style="font-size:${Math.round(w * 0.028)}px;letter-spacing:0.2em;text-transform:uppercase;opacity:0.85">${escapeXml(meta.name)}</div><div style="font-size:${big}px;font-weight:700;line-height:1.05;margin-top:0.3em">${escapeXml(tag)}</div></div>`;
  return {
    handle,
    bio: `${meta.name} — ${tag} ${handle}`,
    hashtags: [`#${meta.name.replace(/\s+/g, "")}`, `#${(meta.industry || "brand").replace(/\s+/g, "")}`, "#design", "#branding"],
    cadence: "3–5 posts a week; one hero story, the rest supporting.",
    templates: [
      { platform: "instagram-post", width: 1080, height: 1080, layout: "quote", html: card(1080, 1080, 84) },
      { platform: "x-post", width: 1200, height: 675, layout: "announcement", html: card(1200, 675, 72) },
      { platform: "linkedin-banner", width: 1584, height: 396, layout: "headline", html: card(1584, 396, 56) },
    ],
  };
}

function buildMarketing(meta: KitMeta, palette: BrandKit["palette"], colors: ColorSystem, fonts: FontPairing, logo: LogoSet, taglines: string[]): Marketing {
  const head = `'${fonts.heading.family}', ${fonts.heading.category}`;
  const body = `'${fonts.body.family}', ${fonts.body.category}`;
  const onPrimary = colors.primary.text;
  const tag = taglines[0] ?? "";
  const cardFront = `<div style="width:1050px;height:600px;background:${palette.primary};color:${onPrimary};display:flex;align-items:center;justify-content:center;font-family:${head}"><div style="text-align:center"><div style="font-size:96px;font-weight:700">${escapeXml(meta.name)}</div><div style="font-family:${body};font-size:34px;opacity:0.85;margin-top:12px">${escapeXml(tag)}</div></div></div>`;
  const cardBack = `<div style="width:1050px;height:600px;background:${palette.light};color:${palette.dark};display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box;font-family:${body}"><div style="font-family:${head};font-size:40px;font-weight:700">Your Name</div><div style="font-size:26px;color:${palette.primary}">Role · ${meta.name}</div><div style="margin-top:24px;font-size:24px">hello@${meta.slug}.com · ${meta.slug}.com</div></div>`;
  const letterhead = `<div style="width:794px;min-height:1123px;background:#fff;color:${palette.dark};font-family:${body};padding:64px;box-sizing:border-box"><div style="border-bottom:3px solid ${palette.primary};padding-bottom:16px;font-family:${head};font-size:34px;font-weight:700;color:${palette.primary}">${escapeXml(meta.name)}</div><div style="margin-top:32px;font-size:16px;line-height:1.7;color:${palette.muted}">Dear [Name],</div><div style="height:400px"></div><div style="font-size:14px;color:${palette.muted}">${meta.slug}.com</div></div>`;
  const emailSignature = `<table style="font-family:${body};color:${palette.dark};font-size:14px"><tr><td style="padding-right:16px;border-right:2px solid ${palette.primary}"><strong style="font-family:${head};font-size:18px;color:${palette.primary}">${escapeXml(meta.name)}</strong></td><td style="padding-left:16px"><div><strong>Your Name</strong> · Role</div><div style="color:${palette.muted}">hello@${meta.slug}.com · ${meta.slug}.com</div></td></tr></table>`;
  const onePager = `<div style="width:794px;background:${palette.light};color:${palette.dark};font-family:${body};padding:56px;box-sizing:border-box"><h1 style="font-family:${head};color:${palette.primary};font-size:44px;margin:0">${escapeXml(meta.name)}</h1><p style="font-size:22px;color:${palette.secondary}">${escapeXml(tag)}</p><p style="font-size:16px;line-height:1.7">${escapeXml(meta.name)} helps you get where you're going. This one-pager is styled entirely from the brand kit.</p></div>`;
  const presentationCover = `<div style="width:1920px;height:1080px;background:${palette.secondary};color:${onPrimary};display:flex;flex-direction:column;justify-content:center;padding:160px;box-sizing:border-box;font-family:${head}"><div style="width:120px">${logo.icon}</div><div style="font-size:120px;font-weight:700;margin-top:40px">${escapeXml(meta.name)}</div><div style="font-family:${body};font-size:40px;opacity:0.85">${escapeXml(tag)}</div></div>`;
  return { businessCard: { front: cardFront, back: cardBack }, letterhead, emailSignature, onePager, presentationCover };
}

function buildGuidelines(meta: KitMeta, colors: ColorSystem, typography: TypographySystem, strategy: Strategy): Guidelines {
  const sections = [
    { id: "strategy", title: "Brand Strategy", page: 1 },
    { id: "logo", title: "Logo", page: 2 },
    { id: "colors", title: "Colors", page: 3 },
    { id: "typography", title: "Typography", page: 4 },
    { id: "visual", title: "Visual Language", page: 5 },
    { id: "voice", title: "Voice & Tone", page: 6 },
  ];
  const doDont: DoDont[] = [
    { do: "Use the primary colour for key actions", dont: "Recolour the logo per campaign" },
    { do: "Keep clear space around the logo", dont: "Stretch or rotate the mark" },
    { do: "Pair the heading and body fonts as specified", dont: "Introduce a third typeface" },
    { do: "Check text contrast against the ratios table", dont: "Put the accent colour behind body text" },
    { do: "Write the way the tone table describes", dont: "Slip into jargon or hype" },
    { do: "Reuse the icon stroke and corners", dont: "Mix icon styles in one screen" },
  ];
  const swatch = (label: string, hex: string) =>
    `<div style="display:inline-block;text-align:center;margin:8px"><div style="width:120px;height:80px;background:${hex};border-radius:8px"></div><div style="font-family:monospace;font-size:12px;margin-top:6px">${label}<br>${hex}</div></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(meta.name)} — Brand Guidelines</title><style>@page{size:A4;margin:24mm}body{font-family:'${typography.body.family}',sans-serif;color:#111;max-width:800px;margin:0 auto;padding:24px}h1{font-family:'${typography.headings.family}',sans-serif;color:${colors.primary.hex};font-size:40px}h2{font-family:'${typography.headings.family}',sans-serif;border-bottom:2px solid ${colors.primary.hex};padding-bottom:6px;margin-top:40px}.mono{font-family:monospace}</style></head><body><h1>${escapeXml(meta.name)}</h1><p><em>Brand Guidelines · generated by BrandForge</em></p><h2>01 · Strategy</h2><p><strong>Mission.</strong> ${escapeXml(strategy.mission)}</p><p><strong>Vision.</strong> ${escapeXml(strategy.vision)}</p><p><strong>Positioning.</strong> ${escapeXml(strategy.positioning.statement)}</p><h2>03 · Colors</h2><div>${swatch("Primary", colors.primary.hex)}${swatch("Secondary", colors.secondary.hex)}${swatch("Accent", colors.accent.hex)}</div><h2>04 · Typography</h2><p>Headings — <strong>${typography.headings.family}</strong>. Body — <strong>${typography.body.family}</strong>. Scale ratio ${typography.ratio}.</p><h2>Do & Don't</h2><ul>${doDont.map((d) => `<li><strong>Do</strong> ${escapeXml(d.do)}. <strong>Don't</strong> ${escapeXml(d.dont)}.</li>`).join("")}</ul></body></html>`;
  return {
    summary: `A one-page identity for ${meta.name}: how to use the logo, colours, type and voice so everything looks like it came from the same place.`,
    sections,
    doDont,
    html,
  };
}

export function generateBrandKit(input: BrandBrief): BrandKit {
  const brief: BrandBrief = {
    name: input.name.trim().length > 0 ? input.name.trim() : "Untitled",
    ...(input.industry !== undefined ? { industry: input.industry } : {}),
    ...(input.vibe !== undefined ? { vibe: input.vibe } : {}),
  };

  const seed = seedFromBrief(brief);
  const rand = mulberry32(seed);
  const { keys: matchedVibes, profiles } = resolveVibes(brief.vibe);

  // Hue: average the preferred windows of the matched vibes, with the seed choosing
  // a point inside. No recognised vibe → the seed roams the whole wheel.
  let hue: number;
  if (profiles.length > 0) {
    const centre =
      profiles.reduce((sum, p) => sum + (p.hue[0] + p.hue[1]) / 2, 0) / profiles.length;
    const spread = 26;
    hue = centre + (rand() * 2 - 1) * spread;
  } else {
    hue = rand() * 360;
  }

  const saturation =
    profiles.length > 0
      ? profiles.reduce((sum, p) => sum + p.saturation, 0) / profiles.length
      : 55 + rand() * 25;

  // Scheme: the first matched vibe leads; otherwise the seed picks one.
  const scheme: ColourScheme =
    profiles[0]?.scheme ??
    (["complementary", "analogous", "triadic"] as const)[Math.floor(rand() * 3)]!;

  const accentShift = scheme === "complementary" ? 180 : scheme === "triadic" ? 120 : 32;

  const primary = hslToHex(hue, saturation, 52);
  const secondary = hslToHex(hue, saturation * 0.7, 26);
  const accent = hslToHex(hue + accentShift, Math.min(saturation + 14, 95), 56);
  const dark = hslToHex(hue, 14, 11);
  const light = hslToHex(hue, 18, 97);
  const muted = hslToHex(hue, Math.min(saturation * 0.4, 24), 60);

  const swatches: Swatch[] = (
    [
      ["primary", primary],
      ["secondary", secondary],
      ["accent", accent],
      ["dark", dark],
      ["light", light],
      ["muted", muted],
    ] as const
  ).map(([role, hex]) => ({ role, hex, textOn: readableTextOn(hex) }));

  const pairing = choosePairing(profiles, rand);
  const fonts: FontPairing = {
    heading: pairing.heading,
    body: pairing.body,
    googleFontsUrl: googleFontsUrl([pairing.heading, pairing.body]),
    rationale: pairing.rationale,
  };

  const adjectives =
    profiles.length > 0
      ? dedupe(profiles.flatMap((p) => p.adjectives))
      : ["modern", "bold"];
  const voice =
    profiles.length > 0
      ? dedupe(profiles.flatMap((p) => p.voice)).slice(0, 4)
      : ["clear", "human", "confident"];

  const taglines = buildTaglines(brief, adjectives, rand);

  const cssVariables = [
    ":root {",
    `  --brand-primary: ${primary};`,
    `  --brand-secondary: ${secondary};`,
    `  --brand-accent: ${accent};`,
    `  --brand-dark: ${dark};`,
    `  --brand-light: ${light};`,
    `  --brand-muted: ${muted};`,
    `  --font-heading: "${fonts.heading.family}", ${fonts.heading.category};`,
    `  --font-body: "${fonts.body.family}", ${fonts.body.category};`,
    "}",
  ].join("\n");

  /* ---- v2: the full kit ---- */
  const leadVibe = matchedVibes[0] ?? "modern";
  const meta: KitMeta = {
    name: brief.name,
    slug: slugify(brief.name),
    industry: brief.industry ?? "",
    vibes: matchedVibes,
    seed,
    version: "2.0",
  };

  const strategy = buildStrategy(brief, matchedVibes, adjectives, rand);

  const colors: ColorSystem = {
    primary: detailedSwatch(primary, "Primary actions, links, brand moments"),
    secondary: detailedSwatch(secondary, "Headers, dark surfaces, depth"),
    accent: detailedSwatch(accent, "Highlights, focus states, calls to action"),
    background: {
      light: detailedSwatch(light, "Default page background"),
      dark: detailedSwatch(dark, "Dark-mode surfaces, footers"),
      muted: detailedSwatch(muted, "Secondary text, borders, disabled states"),
    },
    ramps: {
      primary: rampFromHex(primary),
      secondary: rampFromHex(secondary),
      accent: rampFromHex(accent),
      neutral: rampFromHex(dark, { neutral: true }),
    },
    ratios: [
      { fg: primary, bg: light },
      { fg: accent, bg: light },
      { fg: light, bg: primary },
      { fg: light, bg: dark },
      { fg: primary, bg: dark },
    ].map(({ fg, bg }) => {
      const ratio = contrastRatio(fg, bg);
      return { fg, bg, ratio, pass: passRating(ratio) };
    }),
  };

  const ratio = TYPE_RATIO[leadVibe] ?? 1.25;
  const typography: TypographySystem = {
    headings: {
      family: fonts.heading.family,
      weights: fonts.heading.weights,
      fallback: fonts.heading.category,
      link: fonts.googleFontsUrl,
    },
    body: {
      family: fonts.body.family,
      weights: fonts.body.weights,
      fallback: fonts.body.category,
      link: fonts.googleFontsUrl,
    },
    scale: buildTypeScale(ratio),
    ratio,
  };

  const logo = buildLogo(brief, { primary, secondary, accent, dark, light, muted }, fonts, swatches, MOTIF_BY_VIBE[leadVibe] ?? "roundsquare");
  const visual = buildVisual({ primary, secondary, accent, dark, light, muted }, colors, leadVibe);
  const imagery = buildImagery(brief.industry ?? "", leadVibe);
  const ui = buildUI({ primary, secondary, accent, dark, light, muted }, colors, fonts, leadVibe);
  const voiceKit = buildVoiceKit(strategy, adjectives, leadVibe);
  const social = buildSocial(meta, { primary, secondary, accent, dark, light, muted }, colors, fonts, taglines);
  const marketing = buildMarketing(meta, { primary, secondary, accent, dark, light, muted }, colors, fonts, logo, taglines);
  const guidelines = buildGuidelines(meta, colors, typography, strategy);
  const exports = buildExports(cssVariables, colors, fonts, meta);

  return {
    name: brief.name,
    brief,
    seed,
    matchedVibes,
    scheme,
    palette: { primary, secondary, accent, dark, light, muted },
    swatches,
    fonts,
    tagline: taglines[0]!,
    taglines,
    voice,
    cssVariables,
    meta,
    strategy,
    logo,
    colors,
    typography,
    visual,
    imagery,
    ui,
    voiceKit,
    social,
    marketing,
    guidelines,
    exports,
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** The vibe words the generator understands, for UI chips and docs. */
export const KNOWN_VIBES: string[] = [
  ...Object.keys(VIBES),
  ...Object.keys(VIBE_ALIASES),
].sort();
