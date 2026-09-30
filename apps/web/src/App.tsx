import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { generateBrandKit, KNOWN_VIBES } from "@brandkit";
import type { BrandKit } from "@brandkit";
import type { Receipt, Stats, Trace } from "./types";
import { KitViewer } from "./KitViewer";
import { makeZip, downloadBlob } from "./zip";
import "./brandkit.css";

const PRICE_USDC = 0.03;
const BRAND_KIT_ROUTE = "/v1/brand-kit";
/** brand-kit is the only $0.03 route, so its price uniquely identifies its settlements. */
const BRAND_KIT_PRICE_BASE = 30_000;

/** The vibe chips shown in the form. A curated subset of the generator's vocabulary. */
const VIBE_CHIPS = [
  "modern",
  "bold",
  "playful",
  "luxury",
  "warm",
  "minimal",
  "corporate",
  "creative",
  "calm",
  "energetic",
] as const;

/* ------------------------------------------------------------------ *
 * Data hooks
 * ------------------------------------------------------------------ */

function useProof() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, r, t] = await Promise.all([
        fetch("/api/stats").then((x) => x.json() as Promise<Stats>),
        // A wider window than we display: brand-kit payments are filtered out of a
        // mixed receipt stream, so we need enough rows to find the recent ones.
        fetch("/api/receipts?limit=50").then(
          (x) => x.json() as Promise<{ receipts: Receipt[] }>,
        ),
        // Traces carry the true paid route + settlement tx id, which lets us
        // identify a brand-kit payment even if the chain listener relabels it.
        fetch("/api/traces?limit=50").then(
          (x) => x.json() as Promise<{ traces: Trace[] }>,
        ),
      ]);
      setStats(s);
      setReceipts(r.receipts);
      setTraces(t.traces);
    } catch {
      // Leave the last known values; a transient failure should not blank real numbers.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { stats, receipts, traces, refresh };
}

/** Loads the kit's Google Fonts into the document so the preview renders in them. */
function useGoogleFonts(url: string | null) {
  useEffect(() => {
    if (!url) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, [url]);
}

/** Inbound settlements for the brand-kit route only, newest first, capped. */
function useKitPayments(receipts: Receipt[], traces: Trace[]): Receipt[] {
  return useMemo(() => {
    const kitTxIds = new Set(
      traces.filter((t) => t.route === BRAND_KIT_ROUTE && t.txId).map((t) => t.txId as string),
    );
    return receipts
      .filter(
        (r) =>
          r.direction === "in" &&
          (r.route === BRAND_KIT_ROUTE ||
            r.amountBase === BRAND_KIT_PRICE_BASE ||
            kitTxIds.has(r.txId)),
      )
      .sort((a, b) => b.settledAt.localeCompare(a.settledAt))
      .slice(0, 5);
  }, [receipts, traces]);
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

interface SubmittedBrief {
  name: string;
  industry: string;
  vibe: string[];
}

export default function App() {
  // Draft input the user is typing — does NOT drive the kit on its own.
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [vibes, setVibes] = useState<string[]>([]);
  // The brief that has actually been submitted. The kit is built from THIS only,
  // when the user clicks Generate — not live on every keystroke.
  const [brief, setBrief] = useState<SubmittedBrief | null>(null);

  const kit = useMemo<BrandKit>(
    () => generateBrandKit(brief ?? { name: "" }),
    [brief],
  );
  const emptyBrief = brief === null;
  const canGenerate = name.trim().length > 0;
  // True when the current input differs from what's on screen — prompts a re-generate.
  const dirty =
    brief !== null &&
    (brief.name !== name || brief.industry !== industry || brief.vibe.join(",") !== vibes.join(","));

  const generate = () => {
    if (canGenerate) setBrief({ name, industry, vibe: vibes });
  };

  useGoogleFonts(kit.fonts.googleFontsUrl);
  const proof = useProof();
  const kitPayments = useKitPayments(proof.receipts, proof.traces);

  // The "paid kit · settled" badge is tied to a real settlement event: it shows
  // briefly when a new brand-kit payment lands, not permanently.
  const [justPaid, setJustPaid] = useState(false);
  const prevPaidCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevPaidCount.current !== null && kitPayments.length > prevPaidCount.current) {
      setJustPaid(true);
      const t = setTimeout(() => setJustPaid(false), 6_000);
      prevPaidCount.current = kitPayments.length;
      return () => clearTimeout(t);
    }
    prevPaidCount.current = kitPayments.length;
  }, [kitPayments.length]);

  const toggleVibe = (v: string) =>
    setVibes((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));

  return (
    <div className="app">
      <header className="bf-header">
        <div className="bf-brandwrap">
          <LogoMark />
          <span className="bf-wordmark">BrandForge</span>
        </div>
        <HeaderStats stats={proof.stats} />
      </header>

      <main className="bf-main">
        <div className="bf-left">
          <BriefCard
            name={name}
            industry={industry}
            vibes={vibes}
            onName={setName}
            onIndustry={setIndustry}
            onToggleVibe={toggleVibe}
            onGenerate={generate}
            canGenerate={canGenerate}
            dirty={dirty}
          />
          <PayCard kit={kit} empty={emptyBrief} onSettled={proof.refresh} />
        </div>

        <div className="bf-right">
          <KitViewer
            kit={kit}
            empty={emptyBrief}
            unlocked={justPaid || kitPayments.length > 0}
            onGetKit={() =>
              document.getElementById("bf-get-the-kit")?.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          />
          <div className="bf-bottom">
            <ExportCard kit={kit} empty={emptyBrief} />
            <PaymentsCard payments={kitPayments} />
          </div>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function LogoMark() {
  return (
    <svg className="bf-logo" viewBox="0 0 100 100" role="img" aria-label="BrandForge logo">
      <rect x="0" y="0" width="46" height="46" rx="8" fill="#2451D6" />
      <rect x="54" y="0" width="46" height="46" rx="8" fill="#12A4B4" />
      <rect x="0" y="54" width="46" height="46" rx="8" fill="#F4B33D" />
      <rect x="54" y="54" width="46" height="46" rx="8" fill="#F3F6FB" />
    </svg>
  );
}

function HeaderStats({ stats }: { stats: Stats | null }) {
  return (
    <div className="bf-stats" aria-live="polite">
      <HeaderStat label="Payments settled" value={num(stats?.settleCount)} />
      <HeaderStat label="Paying wallets" value={num(stats?.distinctPayers)} />
      <HeaderStat label="USDC received" value={stats ? stats.totalUsdc.toFixed(2) : "—"} />
      <HeaderStat
        label="Network"
        value={stats ? (stats.network === "mainnet" ? "Algorand MainNet" : "Algorand TestNet") : "—"}
        wide
      />
    </div>
  );
}

function HeaderStat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  // Remounting the value span on change replays the flash+pop animation. The pulse
  // counter starts at 0 so the very first render does not flash.
  const prev = useRef<string | undefined>(undefined);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) setPulse((p) => p + 1);
    prev.current = value;
  }, [value]);
  return (
    <div className="bf-stat">
      <span className="bf-stat-label">{label}</span>
      <span key={pulse} className={`bf-stat-value ${wide ? "wide" : ""} ${pulse > 0 ? "flash" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Brief
 * ------------------------------------------------------------------ */

function BriefCard({
  name,
  industry,
  vibes,
  onName,
  onIndustry,
  onToggleVibe,
  onGenerate,
  canGenerate,
  dirty,
}: {
  name: string;
  industry: string;
  vibes: string[];
  onName: (v: string) => void;
  onIndustry: (v: string) => void;
  onToggleVibe: (v: string) => void;
  onGenerate: () => void;
  canGenerate: boolean;
  dirty: boolean;
}) {
  return (
    <section
      className="bf-card"
      onKeyDown={(e) => {
        // Enter from an input submits the whole brief.
        if (e.key === "Enter" && canGenerate) onGenerate();
      }}
    >
      <div className="bf-card-head">
        <span className="bf-eyebrow">Brief</span>
      </div>

      <label className="bf-field">
        <span className="bf-label">Brand name</span>
        <input
          className="bf-input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="e.g. Northwind"
          aria-label="Brand name"
        />
      </label>

      <label className="bf-field">
        <span className="bf-label">What it does</span>
        <input
          className="bf-input"
          value={industry}
          onChange={(e) => onIndustry(e.target.value)}
          placeholder="e.g. fintech"
          aria-label="What it does"
        />
      </label>

      <div className="bf-field">
        <span className="bf-label">Vibe</span>
        <div className="bf-chips">
          {VIBE_CHIPS.map((v) => (
            <button
              type="button"
              key={v}
              className={`bf-chip ${vibes.includes(v) ? "on" : ""}`}
              aria-pressed={vibes.includes(v)}
              onClick={() => onToggleVibe(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <p className="bf-caption">
          {KNOWN_VIBES.length} vibe words understood, including synonyms like “sleek”, “premium”, “earthy”.
        </p>
      </div>

      <button type="button" className="bf-btn primary bf-generate" onClick={onGenerate} disabled={!canGenerate}>
        {dirty ? "Update kit" : "Generate kit"}
      </button>
      {!canGenerate ? (
        <p className="bf-caption">Enter a brand name, then generate your kit.</p>
      ) : dirty ? (
        <p className="bf-caption">Your brief changed — click to rebuild the kit.</p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Pay
 * ------------------------------------------------------------------ */

interface Challenge {
  amountUsdc: number | null;
  amountBase: string | null;
  network: string | null;
  asset: string | null;
  payTo: string | null;
  scheme: string | null;
  tag: string | null;
  version: number | null;
}

/** Decodes the base64 `payment-required` header into the fields we display. */
function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header.trim())) as {
      x402Version?: number;
      accepts?: {
        scheme?: string;
        network?: string;
        amount?: string;
        asset?: string;
        payTo?: string;
        extra?: { tag?: string; asset?: string };
      }[];
    };
    const a = decoded.accepts?.[0];
    if (!a) return null;
    const amount = Number(a.amount);
    return {
      amountUsdc: Number.isFinite(amount) ? amount / 1_000_000 : null,
      amountBase: a.amount ?? null,
      network: a.network ?? null,
      asset: a.asset ?? a.extra?.asset ?? null,
      payTo: a.payTo ?? null,
      scheme: a.scheme ?? null,
      tag: a.extra?.tag ?? null,
      version: decoded.x402Version ?? null,
    };
  } catch {
    return null;
  }
}

function PayCard({ kit, empty, onSettled }: { kit: BrandKit; empty: boolean; onSettled: () => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const paidUrl = useMemo(() => {
    const params = new URLSearchParams({ name: kit.name });
    if (kit.brief.industry) params.set("industry", kit.brief.industry);
    if ((kit.brief.vibe?.length ?? 0) > 0) params.set("vibe", (kit.brief.vibe ?? []).join(","));
    return `/v1/brand-kit?${params.toString()}`;
  }, [kit]);

  const pay = useCallback(() => {
    // Opens the paid endpoint. A browser gets the x402 paywall (Pera / Defly / Lute);
    // after payment the same kit is returned from the API. Refresh proof shortly after.
    window.open(paidUrl, "_blank", "noopener");
    timeoutRef.current = window.setTimeout(onSettled, 12_000);
  }, [paidUrl, onSettled]);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const previewChallenge = useCallback(async () => {
    setChecking(true);
    setChallenge(null);
    setStatus(null);
    try {
      const res = await fetch(paidUrl);
      setStatus(res.status);
      setChallenge(parseChallenge(res.headers.get("payment-required")));
    } catch {
      setStatus(0);
    } finally {
      setChecking(false);
    }
  }, [paidUrl]);

  return (
    <section className="bf-card" id="bf-get-the-kit">
      <div className="bf-card-head">
        <span className="bf-eyebrow">Get the kit</span>
        <span className="bf-price">${PRICE_USDC.toFixed(2)} USDC</span>
      </div>

      <button type="button" className="bf-btn primary" onClick={pay} disabled={empty}>
        Pay $0.03 via x402 →
      </button>
      <button
        type="button"
        className="bf-btn outline"
        onClick={() => void previewChallenge()}
        disabled={checking}
      >
        {checking ? "checking…" : "Show the 402 challenge"}
      </button>
      {empty ? <p className="bf-caption">Generate a kit first, then pay to get it.</p> : null}

      <ChallengeBox status={status} challenge={challenge} />
    </section>
  );
}

function ChallengeBox({ status, challenge }: { status: number | null; challenge: Challenge | null }) {
  if (status === null) {
    return <div className="bf-challenge empty">challenge appears here</div>;
  }
  const rows: [string, ReactNode][] = [];
  rows.push([
    "status",
    <strong className="bf-strong">
      {status === 402 ? "HTTP 402 Payment Required" : status === 0 ? "request failed" : `HTTP ${status}`}
    </strong>,
  ]);
  if (challenge) {
    if (challenge.amountUsdc !== null) {
      rows.push([
        "price",
        `$${challenge.amountUsdc.toFixed(2)} · ${challenge.amountBase ?? "?"} base units`,
      ]);
    }
    rows.push(["asset", `USDC · ASA ${challenge.asset ?? "—"}`]);
    rows.push(["network", networkLabel(challenge.network)]);
    rows.push(["payTo", truncMid(challenge.payTo)]);
    rows.push(["scheme", `x402 v${challenge.version ?? 2} · ${challenge.scheme ?? "exact"}`]);
    if (challenge.tag) rows.push(["tag", challenge.tag]);
  }
  return (
    <div className="bf-challenge filled">
      {rows.map(([k, v], i) => (
        <div className="bf-krow" style={{ animationDelay: `${i * 0.06}s` }} key={k}>
          <span className="bf-k">{k}</span>
          <span className="bf-v">{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

const EXPORT_TABS = ["CSS", "Tailwind", "JSON"] as const;

function ExportCard({ kit, empty }: { kit: BrandKit; empty: boolean }) {
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);
  const [tab, setTab] = useState<(typeof EXPORT_TABS)[number]>("CSS");
  const slug = kit.meta.slug;

  const fullJson = useMemo(() => JSON.stringify(kit, null, 2), [kit]);
  const tabText =
    tab === "CSS" ? kit.exports.cssVariables : tab === "Tailwind" ? kit.exports.tailwind : fullJson;

  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setFlash(true);
      setTimeout(() => setCopied(false), 2_000);
      setTimeout(() => setFlash(false), 500);
    });
  }, []);

  const zip = useCallback(() => {
    const blob = makeZip([
      { name: `${slug}/brand-kit.json`, content: fullJson },
      { name: `${slug}/brand.css`, content: kit.exports.cssVariables },
      { name: `${slug}/tailwind.config.js`, content: kit.exports.tailwind },
      { name: `${slug}/figma-tokens.json`, content: kit.exports.figmaTokens },
      { name: `${slug}/logo-primary.svg`, content: kit.logo.primary },
      { name: `${slug}/logo-icon.svg`, content: kit.logo.icon },
      { name: `${slug}/logo-stacked.svg`, content: kit.logo.secondary },
      { name: `${slug}/guidelines.html`, content: kit.guidelines.html },
    ]);
    downloadBlob(blob, `${slug}-brand-kit.zip`);
  }, [kit, fullJson, slug]);

  if (empty) {
    return (
      <section className="bf-card">
        <div className="bf-card-head">
          <span className="bf-eyebrow">Export</span>
        </div>
        <p className="bf-empty-note">Generate a kit to export its CSS, Tailwind, Figma tokens and zip.</p>
      </section>
    );
  }

  return (
    <section className="bf-card">
      <div className="bf-card-head">
        <span className="bf-eyebrow">Export</span>
      </div>
      <div className="bf-export">
        <button type="button" className={`bf-btn export ${copied ? "done" : ""}`} onClick={() => copy(kit.exports.cssVariables)}>
          {copied ? "Copied" : "Copy CSS variables"}
        </button>
        <button type="button" className="bf-btn export" onClick={() => copy(kit.exports.tailwind)}>
          Copy Tailwind config
        </button>
        <a className="bf-btn export" href={`data:application/json,${encodeURIComponent(fullJson)}`} download={`${slug}-kit.json`}>
          Download JSON
        </a>
        <a className="bf-btn export" href={`data:application/json,${encodeURIComponent(kit.exports.figmaTokens)}`} download={`${slug}-figma-tokens.json`}>
          Download Figma tokens
        </a>
        <button type="button" className="bf-btn export" onClick={zip}>
          Download full kit (.zip)
        </button>
      </div>

      <div className="bf-code-tabs">
        {EXPORT_TABS.map((t) => (
          <button key={t} type="button" className={`bf-codetab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <pre className={`bf-code ${flash ? "flash" : ""}`}>{tabText}</pre>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Recent brand kit payments
 * ------------------------------------------------------------------ */

function PaymentsCard({ payments }: { payments: Receipt[] }) {
  return (
    <section className="bf-card">
      <div className="bf-card-head">
        <span className="bf-eyebrow">Recent brand kit payments</span>
      </div>
      {payments.length === 0 ? (
        <div className="bf-empty">no brand-kit payments yet</div>
      ) : (
        <ul className="bf-pay-list">
          {payments.map((r) => (
            <li className="bf-pay-row" key={r.txId}>
              <div className="bf-pay-line">
                <span className="bf-pay-label">
                  <span className="bf-pay-dot" /> brand-kit
                </span>
                <span className="bf-pay-amount">+{r.amountUsdc.toFixed(2)} USDC</span>
              </div>
              <div className="bf-pay-meta">
                <span>from {truncMid(r.payer)}</span>
                <a href={r.explorerUrl} target="_blank" rel="noreferrer" className="bf-pay-link">
                  tx {truncMid(r.txId)} ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function num(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}

/** Middle-truncates an address / tx id, keeping the ends. */
function truncMid(s: string | null, head = 8, tail = 8): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function networkLabel(caip2: string | null): string {
  if (!caip2) return "—";
  // Distinguish by genesis hash so the 402 panel names the real network.
  if (caip2.includes("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8")) return "Algorand MainNet";
  if (caip2.startsWith("algorand:")) return "Algorand TestNet";
  return caip2;
}
