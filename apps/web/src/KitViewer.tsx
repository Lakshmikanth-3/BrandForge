import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BrandKit, ContrastRow, DetailedSwatch, Ramp, ScaleRow } from "@brandkit";

/** The 11 sections, in order. Locked ones are gated behind the paid kit. */
const SECTIONS = [
  { id: "strategy", n: "01", title: "Brand Strategy", locked: false },
  { id: "logo", n: "02", title: "Logo", locked: false },
  { id: "colors", n: "03", title: "Colors", locked: false },
  { id: "typography", n: "04", title: "Typography", locked: false },
  { id: "visual", n: "05", title: "Visual Language", locked: true },
  { id: "imagery", n: "06", title: "Imagery", locked: true },
  { id: "ui", n: "07", title: "UI System", locked: true },
  { id: "voice", n: "08", title: "Voice & Tone", locked: false },
  { id: "social", n: "09", title: "Social Media", locked: true },
  { id: "marketing", n: "10", title: "Marketing", locked: true },
  { id: "guidelines", n: "11", title: "Guidelines", locked: true },
] as const;

export function KitViewer({
  kit,
  empty,
  unlocked,
  onGetKit,
}: {
  kit: BrandKit;
  empty: boolean;
  unlocked: boolean;
  onGetKit: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>("strategy");

  // Scroll-spy: the section nearest the top of the body is "current".
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const root = bodyRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id.replace("sec-", ""));
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(`sec-${s.id}`);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  const jump = (id: string) => {
    const el = document.getElementById(`sec-${id}`);
    const root = bodyRef.current;
    if (el && root) root.scrollTo({ top: el.offsetTop - root.offsetTop - 8, behavior: "smooth" });
    setActive(id);
  };

  return (
    <section className="bf-card bf-viewer-card">
      <div className="bf-card-head">
        <span className="bf-eyebrow">Kit viewer</span>
        {unlocked && !empty ? (
          <span className="bf-paidbadge">
            <span className="bf-paiddot" /> paid kit · settled on Algorand
          </span>
        ) : null}
      </div>

      <div className="bf-viewer">
        <nav className="bf-vnav" aria-label="Kit sections">
          {SECTIONS.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`bf-navitem ${s.locked && !unlocked ? "flash-unlock" : ""}`}
              aria-current={active === s.id}
              onClick={() => jump(s.id)}
            >
              <span className="n">{s.n}</span>
              <span className="t">{s.title}</span>
              {s.locked && !unlocked ? <LockIcon /> : <span />}
            </button>
          ))}
        </nav>

        <div className="bf-vbody" ref={bodyRef}>
          {empty ? (
            <div className="bf-viewer-empty">
              <h3 className="bf-sec-title">Your brand kit appears here</h3>
              <p className="bf-empty-note">
                Type a brand name on the left — and optionally what it does and a few vibe words —
                to generate its colours, fonts, logo, voice and more, live.
              </p>
            </div>
          ) : (
            SECTIONS.map((s) => (
              <div className="bf-sec" id={`sec-${s.id}`} key={s.id}>
                <div className="bf-sec-eyebrow">
                  {s.n} · {s.title.toUpperCase()}
                </div>
                <h3 className="bf-sec-title">{s.title}</h3>
                {s.locked && !unlocked ? (
                  <LockedPanel title={s.title} onGetKit={onGetKit} />
                ) : (
                  <SectionBody id={s.id} kit={kit} />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function SectionBody({ id, kit }: { id: string; kit: BrandKit }) {
  switch (id) {
    case "strategy":
      return <Strategy kit={kit} />;
    case "logo":
      return <Logo kit={kit} />;
    case "colors":
      return <Colors kit={kit} />;
    case "typography":
      return <Typography kit={kit} />;
    case "visual":
      return <Visual kit={kit} />;
    case "imagery":
      return <Imagery kit={kit} />;
    case "ui":
      return <UISystem kit={kit} />;
    case "voice":
      return <Voice kit={kit} />;
    case "social":
      return <Social kit={kit} />;
    case "marketing":
      return <Marketing kit={kit} />;
    case "guidelines":
      return <Guidelines kit={kit} />;
    default:
      return <p className="bf-empty-note">Included in your full kit.</p>;
  }
}

/* ---------------- helpers ---------------- */

function toStyle(css: Record<string, string>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(css)) {
    out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as CSSProperties;
}

function downloadHtml(html: string, filename: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Renders a fixed-size HTML string scaled to fit a target width. */
function ScaledHtml({ html, w, h, target = 320 }: { html: string; w: number; h: number; target?: number }) {
  const scale = Math.min(1, target / w);
  return (
    <div className="bf-scaled" style={{ width: w * scale, height: h * scale }}>
      <div
        style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "top left" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/* ---------------- 01 Strategy ---------------- */

function Strategy({ kit }: { kit: BrandKit }) {
  const s = kit.strategy;
  return (
    <>
      <div className="bf-2col">
        <div className="bf-panel">
          <span className="bf-subtitle">Mission</span>
          <p className="bf-statement">{s.mission}</p>
        </div>
        <div className="bf-panel">
          <span className="bf-subtitle">Vision</span>
          <p className="bf-statement">{s.vision}</p>
        </div>
      </div>

      <span className="bf-subtitle">Values</span>
      <div className="bf-values">
        {s.values.map((v) => (
          <div className="bf-panel" key={v.title}>
            <strong className="bf-value-title">{v.title}</strong>
            <p className="bf-value-line">{v.line}</p>
          </div>
        ))}
      </div>

      <span className="bf-subtitle">Personality</span>
      <div className="bf-panel bf-persona">
        {s.personality.map((p) => (
          <div className="bf-persona-row" key={p.trait}>
            <span className="bf-persona-trait">{p.trait}</span>
            <span className="bf-persona-is">We are {p.is}</span>
            <span className="bf-persona-isnot">Not {p.isNot}</span>
          </div>
        ))}
      </div>

      <span className="bf-subtitle">Positioning</span>
      <div className="bf-panel">
        <p className="bf-statement">{s.positioning.statement}</p>
        <div className="bf-mini-grid">
          <Mini label="For" value={s.positioning.forWho} />
          <Mini label="Category" value={s.positioning.category} />
          <Mini label="Benefit" value={s.positioning.benefit} />
          <Mini label="Unlike" value={s.positioning.unlike} />
        </div>
      </div>
    </>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="bf-mini">
      <span className="bf-mini-label">{label}</span>
      <span className="bf-mini-value">{value}</span>
    </div>
  );
}

/* ---------------- 02 Logo ---------------- */

function Logo({ kit }: { kit: BrandKit }) {
  const light = kit.colors.background.light.hex;
  return (
    <>
      <div className="bf-logo-primary bf-panel" style={{ background: light }}>
        <div className="bf-svgwrap" dangerouslySetInnerHTML={{ __html: kit.logo.primary }} />
      </div>
      <div className="bf-2col">
        <div className="bf-panel bf-logo-tile" style={{ background: light }}>
          <div className="bf-svgwrap sm" dangerouslySetInnerHTML={{ __html: kit.logo.secondary }} />
        </div>
        <div className="bf-panel bf-logo-tile" style={{ background: light }}>
          <div className="bf-svgwrap icon" dangerouslySetInnerHTML={{ __html: kit.logo.icon }} />
        </div>
      </div>
    </>
  );
}

/* ---------------- 03 Colors ---------------- */

function Colors({ kit }: { kit: BrandKit }) {
  const c = kit.colors;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex).then(() => {
      setCopied(hex);
      setTimeout(() => setCopied((h) => (h === hex ? null : h)), 1400);
    });
  };
  return (
    <>
      <div className="bf-bigswatches">
        <BigSwatch role="primary" s={c.primary} onCopy={copy} copied={copied} />
        <BigSwatch role="secondary" s={c.secondary} onCopy={copy} copied={copied} />
        <BigSwatch role="accent" s={c.accent} onCopy={copy} copied={copied} />
      </div>

      <span className="bf-subtitle">Backgrounds</span>
      <div className="bf-bigswatches small">
        <BigSwatch role="light" s={c.background.light} onCopy={copy} copied={copied} />
        <BigSwatch role="dark" s={c.background.dark} onCopy={copy} copied={copied} />
        <BigSwatch role="muted" s={c.background.muted} onCopy={copy} copied={copied} />
      </div>

      <span className="bf-subtitle">Ramps</span>
      <div className="bf-ramps">
        {(["primary", "secondary", "accent", "neutral"] as const).map((r) => (
          <RampRow key={r} label={r} ramp={c.ramps[r]} />
        ))}
      </div>

      <span className="bf-subtitle">Contrast (WCAG)</span>
      <div className="bf-panel bf-contrast">
        {c.ratios.map((row, i) => (
          <ContrastLine key={i} row={row} />
        ))}
      </div>
    </>
  );
}

function BigSwatch({
  role,
  s,
  onCopy,
  copied,
}: {
  role: string;
  s: DetailedSwatch;
  onCopy: (hex: string) => void;
  copied: string | null;
}) {
  return (
    <button
      type="button"
      className="bf-bigswatch"
      style={{ background: s.hex, color: s.text }}
      onClick={() => onCopy(s.hex)}
      title={`Copy ${s.hex}`}
    >
      <span className="bf-bs-role">{role}</span>
      <span className="bf-bs-meta mono">{copied === s.hex ? `Copied ${s.hex.toUpperCase()}` : s.hex.toUpperCase()}</span>
      <span className="bf-bs-meta mono dim">{s.rgb}</span>
      <span className="bf-bs-usage">{s.usage}</span>
    </button>
  );
}

function RampRow({ label, ramp }: { label: string; ramp: Ramp }) {
  return (
    <div className="bf-ramp">
      <span className="bf-ramp-label">{label}</span>
      <div className="bf-ramp-steps">
        {(Object.keys(ramp) as (keyof Ramp)[]).map((step) => (
          <span
            key={step}
            className="bf-ramp-step"
            style={{ background: ramp[step] }}
            title={`${label} ${step} · ${ramp[step]}`}
          />
        ))}
      </div>
    </div>
  );
}

function ContrastLine({ row }: { row: ContrastRow }) {
  return (
    <div className="bf-contrast-row">
      <span className="bf-contrast-sample" style={{ background: row.bg, color: row.fg }}>
        Aa
      </span>
      <span className="mono">{row.ratio.toFixed(2)}</span>
      <span className={`bf-badge ${row.pass === "fail" ? "fail" : ""}`}>{row.pass}</span>
    </div>
  );
}

/* ---------------- 04 Typography ---------------- */

function Typography({ kit }: { kit: BrandKit }) {
  const t = kit.typography;
  return (
    <>
      <div className="bf-2col">
        <FaceCard label="Headings" family={t.headings.family} weights={t.headings.weights} />
        <FaceCard label="Body" family={t.body.family} weights={t.body.weights} />
      </div>

      <span className="bf-subtitle">
        Type scale · ratio {t.ratio} · base 16px
      </span>
      <div className="bf-panel bf-scale">
        {t.scale.map((row) => (
          <ScaleLine key={row.token} row={row} headFont={t.headings.family} bodyFont={t.body.family} />
        ))}
      </div>
    </>
  );
}

function FaceCard({ label, family, weights }: { label: string; family: string; weights: number[] }) {
  return (
    <div className="bf-panel">
      <span className="bf-subtitle">{label} · {family}</span>
      <div className="bf-face-aa" style={{ fontFamily: `"${family}", sans-serif` }}>
        Aa
      </div>
      <div className="bf-chips-inline">
        {weights.map((w) => (
          <span className="bf-weightpill mono" key={w}>
            {w}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScaleLine({ row, headFont, bodyFont }: { row: ScaleRow; headFont: string; bodyFont: string }) {
  const family = row.font === "heading" ? headFont : bodyFont;
  return (
    <div className="bf-scale-row">
      <span className="bf-scale-token mono">{row.token}</span>
      <span
        className="bf-scale-sample"
        style={{ fontFamily: `"${family}", sans-serif`, fontSize: Math.min(row.px, 40), fontWeight: row.weight }}
      >
        The quick brown fox
      </span>
      <span className="bf-scale-spec mono">
        {row.px}px / {row.lineHeight} / {row.weight}
      </span>
    </div>
  );
}

/* ---------------- 08 Voice ---------------- */

function Voice({ kit }: { kit: BrandKit }) {
  const v = kit.voiceKit;
  return (
    <>
      <span className="bf-subtitle">Traits</span>
      <div className="bf-chips-inline big">
        {kit.voice.map((w) => (
          <span className="bf-voicepill" key={w}>
            {w}
          </span>
        ))}
      </div>

      <span className="bf-subtitle">Tone by context</span>
      <div className="bf-panel bf-tone">
        {v.tone.map((t) => (
          <div className="bf-tone-row" key={t.context}>
            <span className="bf-tone-ctx mono">{t.context}</span>
            <div>
              <p className="bf-tone-desc">{t.description}</p>
              <p className="bf-tone-eg">“{t.example}”</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bf-2col">
        <div>
          <span className="bf-subtitle">Words to use</span>
          <div className="bf-chips-inline">
            {v.wordsToUse.map((w) => (
              <span className="bf-weightpill" key={w}>{w}</span>
            ))}
          </div>
        </div>
        <div>
          <span className="bf-subtitle">Words to avoid</span>
          <div className="bf-chips-inline">
            {v.wordsToAvoid.map((w) => (
              <span className="bf-weightpill strike" key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>

      <span className="bf-subtitle">Taglines</span>
      <div className="bf-panel">
        <ul className="bf-taglines">
          {kit.taglines.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>

      <span className="bf-subtitle">Boilerplate</span>
      <div className="bf-2col">
        <div className="bf-panel">
          <span className="bf-mini-label">Short</span>
          <p className="bf-value-line">{v.boilerplate.short}</p>
        </div>
        <div className="bf-panel">
          <span className="bf-mini-label">Long</span>
          <p className="bf-value-line">{v.boilerplate.long}</p>
        </div>
      </div>
    </>
  );
}

/* ---------------- 05 Visual ---------------- */

function Visual({ kit }: { kit: BrandKit }) {
  const v = kit.visual;
  return (
    <>
      <span className="bf-subtitle">Icons · {v.icons.style} · stroke {v.icons.stroke}</span>
      <div className="bf-icongrid">
        {v.icons.samples.map((ic) => (
          <div className="bf-iconcell" key={ic.name} dangerouslySetInnerHTML={{ __html: ic.svg }} />
        ))}
      </div>

      <span className="bf-subtitle">Shapes</span>
      <div className="bf-2col">
        <div className="bf-panel bf-radii">
          {(["sm", "md", "lg"] as const).map((r) => (
            <div key={r} className="bf-radiobox" style={{ borderRadius: v.shapes.radius[r] }}>
              <span className="mono">{r} {v.shapes.radius[r]}px</span>
            </div>
          ))}
        </div>
        <div className="bf-panel bf-motif" dangerouslySetInnerHTML={{ __html: v.shapes.svg }} />
      </div>

      <span className="bf-subtitle">Gradients</span>
      <div className="bf-gradients">
        {v.gradients.map((g) => (
          <div className="bf-gradtile" key={g.name}>
            <div className="bf-gradfill" style={{ background: g.css }} />
            <span className="mono bf-gradcss">{g.css}</span>
          </div>
        ))}
      </div>

      <span className="bf-subtitle">Patterns</span>
      <div className="bf-2col">
        {v.patterns.map((p) => (
          <div key={p.name} className="bf-patterntile" style={cssTextToStyle(p.css)} title={p.name} />
        ))}
      </div>

      <span className="bf-subtitle">Effects</span>
      <div className="bf-effects">
        {(["sm", "md", "lg"] as const).map((s) => (
          <div key={s} className="bf-effectcard" style={{ boxShadow: v.effects.shadow[s] }}>
            <span className="mono">shadow {s}</span>
          </div>
        ))}
      </div>
      <p className="bf-empty-note mono">motion · {v.effects.motion.duration} · {v.effects.motion.easing}</p>
    </>
  );
}

/** Parses a raw CSS declaration string into a React style object (for pattern tiles). */
function cssTextToStyle(css: string): CSSProperties {
  const obj: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) obj[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return toStyle(obj);
}

/* ---------------- 06 Imagery ---------------- */

function Imagery({ kit }: { kit: BrandKit }) {
  const im = kit.imagery;
  const [src, setSrc] = useState<string | null>(null);
  return (
    <>
      <div className="bf-2col">
        <div className="bf-panel">
          <span className="bf-subtitle">Photography</span>
          <p className="bf-value-line">Mood — {im.photography.mood}</p>
          <p className="bf-value-line">Lighting — {im.photography.lighting}</p>
          <p className="bf-value-line">Composition — {im.photography.composition}</p>
          <div className="bf-chips-inline">
            {im.photography.subjects.map((s) => (
              <span className="bf-weightpill" key={s}>{s}</span>
            ))}
          </div>
        </div>
        <div className="bf-panel">
          <span className="bf-subtitle">Illustration</span>
          <p className="bf-value-line">{im.illustration.style} · {im.illustration.lineWeight}</p>
          <p className="bf-mini-label">Do</p>
          <p className="bf-value-line">{im.illustration.do.join(" · ")}</p>
          <p className="bf-mini-label">Don't</p>
          <p className="bf-value-line">{im.illustration.dont.join(" · ")}</p>
        </div>
      </div>

      <span className="bf-subtitle">Image treatment · {im.treatment.name}</span>
      <div className="bf-panel bf-treatment">
        <div
          className="bf-treatbox"
          style={{
            filter: im.treatment.cssFilter,
            borderRadius: im.treatment.radius,
            background: src ? `url(${src}) center/cover` : "linear-gradient(135deg,#3a3d44,#20222a)",
          }}
        >
          {!src ? <span className="bf-empty-note">drop a photo to preview the treatment</span> : null}
        </div>
        <label className="bf-btn outline bf-treatbtn">
          Choose a photo
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setSrc(URL.createObjectURL(f));
            }}
          />
        </label>
        <p className="bf-empty-note mono">filter: {im.treatment.cssFilter} · overlay: {im.treatment.overlay}</p>
      </div>
    </>
  );
}

/* ---------------- 07 UI System ---------------- */

function UISystem({ kit }: { kit: BrandKit }) {
  const ui = kit.ui;
  const surface = kit.colors.background.light.hex;
  return (
    <div className="bf-panel" style={{ background: surface }}>
      <div className="bf-ui-row">
        {ui.buttons.map((b) => (
          <button key={b.variant} type="button" style={toStyle(b.css)}>
            {b.variant}
          </button>
        ))}
      </div>

      <div className="bf-ui-row">
        <div style={{ ...toStyle(ui.cards.css), maxWidth: 260 }}>
          <strong style={{ color: kit.colors.primary.hex }}>Card title</strong>
          <p style={{ color: "#333", fontSize: 14 }}>A sample card styled from the kit tokens.</p>
          <button type="button" style={toStyle(ui.buttons[0]!.css)}>Action</button>
        </div>
        <div style={{ flex: 1 }}>
          <input placeholder="Default input" style={{ ...toStyle(ui.inputs.css), display: "block", marginBottom: 8, width: "100%" }} />
          <input placeholder="Focus" style={{ ...toStyle(ui.inputs.css), ...toStyle(ui.inputs.focus), display: "block", marginBottom: 8, width: "100%" }} />
          <input placeholder="Error" style={{ ...toStyle(ui.inputs.css), ...toStyle(ui.inputs.error), display: "block", width: "100%" }} />
        </div>
      </div>

      <div className="bf-ui-row" style={toStyle(ui.navigation.css)}>
        {["Home", "Work", "About", "Contact"].map((n, i) => (
          <span key={n} style={{ padding: "6px 12px", borderRadius: 8, ...(i === 0 ? toStyle(ui.navigation.active) : {}) }}>
            {n}
          </span>
        ))}
      </div>

      <div className="bf-ui-row">
        {ui.components.map((c) => (
          <span key={c.name} style={toStyle(c.css)}>{c.name}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 09 Social ---------------- */

function Social({ kit }: { kit: BrandKit }) {
  const s = kit.social;
  return (
    <>
      <div className="bf-panel bf-social-profile">
        <div className="bf-avatar" dangerouslySetInnerHTML={{ __html: kit.logo.icon }} />
        <div>
          <div className="bf-value-title mono">{s.handle}</div>
          <p className="bf-value-line">{s.bio}</p>
        </div>
      </div>

      <span className="bf-subtitle">Templates</span>
      <div className="bf-previews">
        {s.templates.map((t) => (
          <div key={t.platform} className="bf-preview-item">
            <ScaledHtml html={t.html} w={t.width} h={t.height} target={300} />
            <span className="mono bf-preview-label">{t.platform} · {t.width}×{t.height}</span>
          </div>
        ))}
      </div>

      <span className="bf-subtitle">Hashtags · {s.cadence}</span>
      <div className="bf-chips-inline">
        {s.hashtags.map((h) => (
          <span className="bf-weightpill" key={h}>{h}</span>
        ))}
      </div>
    </>
  );
}

/* ---------------- 10 Marketing ---------------- */

function Marketing({ kit }: { kit: BrandKit }) {
  const m = kit.marketing;
  const slug = kit.meta.slug;
  return (
    <>
      <span className="bf-subtitle">Business card</span>
      <div className="bf-previews">
        <Asset html={m.businessCard.front} w={1050} h={600} name={`${slug}-card-front.html`} label="front" />
        <Asset html={m.businessCard.back} w={1050} h={600} name={`${slug}-card-back.html`} label="back" />
      </div>

      <span className="bf-subtitle">Letterhead & one-pager</span>
      <div className="bf-previews">
        <Asset html={m.letterhead} w={794} h={1123} name={`${slug}-letterhead.html`} label="letterhead" />
        <Asset html={m.onePager} w={794} h={520} name={`${slug}-onepager.html`} label="one-pager" />
      </div>

      <span className="bf-subtitle">Presentation cover</span>
      <div className="bf-previews">
        <Asset html={m.presentationCover} w={1920} h={1080} name={`${slug}-cover.html`} label="1920×1080" />
      </div>

      <span className="bf-subtitle">Email signature</span>
      <div className="bf-panel" style={{ background: "#fff" }} dangerouslySetInnerHTML={{ __html: m.emailSignature }} />
      <button type="button" className="bf-btn outline bf-treatbtn" onClick={() => void navigator.clipboard?.writeText(m.emailSignature)}>
        Copy signature HTML
      </button>
    </>
  );
}

function Asset({ html, w, h, name, label }: { html: string; w: number; h: number; name: string; label: string }) {
  return (
    <div className="bf-preview-item">
      <ScaledHtml html={html} w={w} h={h} target={300} />
      <div className="bf-asset-foot">
        <span className="mono bf-preview-label">{label}</span>
        <button type="button" className="bf-linkbtn" onClick={() => downloadHtml(html, name)}>
          download
        </button>
      </div>
    </div>
  );
}

/* ---------------- 11 Guidelines ---------------- */

function Guidelines({ kit }: { kit: BrandKit }) {
  const g = kit.guidelines;
  const print = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(g.html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };
  return (
    <>
      <p className="bf-statement">{g.summary}</p>

      <span className="bf-subtitle">Contents</span>
      <div className="bf-panel">
        <ol className="bf-toc">
          {g.sections.map((s) => (
            <li key={s.id}>
              {s.title} <span className="bf-dim mono">· p.{s.page}</span>
            </li>
          ))}
        </ol>
      </div>

      <span className="bf-subtitle">Do &amp; Don't</span>
      <div className="bf-dodont">
        {g.doDont.map((d, i) => (
          <div className="bf-panel" key={i}>
            <p className="bf-do">✓ {d.do}</p>
            <p className="bf-dont">✕ {d.dont}</p>
          </div>
        ))}
      </div>

      <div className="bf-guide-actions">
        <button type="button" className="bf-btn primary bf-guide-btn" onClick={print}>
          Download guidelines PDF
        </button>
        <button type="button" className="bf-btn outline bf-guide-btn" onClick={() => downloadHtml(g.html, `${kit.meta.slug}-guidelines.html`)}>
          Download HTML
        </button>
      </div>
    </>
  );
}

/* ---------------- Locked ---------------- */

function LockedPanel({ title, onGetKit }: { title: string; onGetKit: () => void }) {
  return (
    <div className="bf-locked">
      <div className="bf-locked-skeleton" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="bf-locked-overlay">
        <LockIcon large />
        <p className="bf-locked-line">
          {title} unlocks with the paid kit · $0.03 USDC
        </p>
        <button type="button" className="bf-btn outline bf-locked-btn" onClick={onGetKit}>
          Get the kit
        </button>
      </div>
    </div>
  );
}

function LockIcon({ large }: { large?: boolean }) {
  const s = large ? 22 : 12;
  return (
    <svg className="bf-lock" width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
