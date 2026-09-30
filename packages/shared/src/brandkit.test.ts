import { describe, expect, it } from "vitest";
import { generateBrandKit, seedFromBrief, KNOWN_VIBES } from "./brandkit.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("brand kit generator", () => {
  it("is deterministic: the same brief yields byte-identical kits", () => {
    const brief = { name: "Northwind", industry: "fintech", vibe: ["modern", "bold"] };
    expect(generateBrandKit(brief)).toEqual(generateBrandKit({ ...brief }));
  });

  it("is order-independent in the vibe words", () => {
    const a = generateBrandKit({ name: "Acme", vibe: ["modern", "bold"] });
    const b = generateBrandKit({ name: "Acme", vibe: ["bold", "modern"] });
    expect(a.seed).toBe(b.seed);
    expect(a.palette).toEqual(b.palette);
  });

  it("produces different kits for different names", () => {
    const a = generateBrandKit({ name: "Northwind", vibe: ["modern"] });
    const b = generateBrandKit({ name: "Southgate", vibe: ["modern"] });
    expect(a.seed).not.toBe(b.seed);
  });

  it("emits valid six-digit hex for every swatch", () => {
    const kit = generateBrandKit({ name: "Palette", vibe: ["playful"] });
    for (const swatch of kit.swatches) {
      expect(swatch.hex).toMatch(HEX);
      expect(["#0b0b0f", "#ffffff"]).toContain(swatch.textOn);
    }
    for (const hex of Object.values(kit.palette)) {
      expect(hex).toMatch(HEX);
    }
  });

  it("recognises known vibes and steers the scheme by them", () => {
    const luxe = generateBrandKit({ name: "Auré", vibe: ["luxury"] });
    expect(luxe.matchedVibes).toContain("luxury");
    expect(luxe.scheme).toBe("analogous");
    // Luxury pulls a serif heading.
    expect(luxe.fonts.heading.category).toBe("serif");
  });

  it("folds synonyms onto canonical vibes", () => {
    const kit = generateBrandKit({ name: "Zephyr", vibe: ["sleek", "premium"] });
    expect(kit.matchedVibes).toEqual(expect.arrayContaining(["modern", "luxury"]));
  });

  it("ignores unknown vibe words for styling but still folds them into the seed", () => {
    const withGibberish = generateBrandKit({ name: "Acme", vibe: ["florpwibble"] });
    const withNone = generateBrandKit({ name: "Acme" });
    expect(withGibberish.matchedVibes).toEqual([]);
    // An unknown word is still part of the brief, so the seed differs.
    expect(withGibberish.seed).not.toBe(withNone.seed);
  });

  it("builds a Google Fonts URL that loads exactly the paired families", () => {
    const kit = generateBrandKit({ name: "Grid", vibe: ["modern"] });
    expect(kit.fonts.googleFontsUrl).toContain(kit.fonts.heading.family.replace(/ /g, "+"));
    expect(kit.fonts.googleFontsUrl).toContain(kit.fonts.body.family.replace(/ /g, "+"));
    expect(kit.fonts.googleFontsUrl).toContain("display=swap");
  });

  it("always returns at least one tagline, headline first", () => {
    const kit = generateBrandKit({ name: "Volt", industry: "energy", vibe: ["bold"] });
    expect(kit.taglines.length).toBeGreaterThan(0);
    expect(kit.tagline).toBe(kit.taglines[0]);
    expect(kit.tagline).toContain("Volt");
  });

  it("emits paste-ready CSS custom properties for colours and fonts", () => {
    const kit = generateBrandKit({ name: "Root", vibe: ["corporate"] });
    expect(kit.cssVariables).toContain("--brand-primary:");
    expect(kit.cssVariables).toContain("--font-heading:");
    expect(kit.cssVariables).toContain(kit.palette.primary);
  });

  it("handles a bare name with no industry or vibe", () => {
    const kit = generateBrandKit({ name: "Solo" });
    expect(kit.name).toBe("Solo");
    expect(kit.swatches).toHaveLength(6);
    expect(kit.voice.length).toBeGreaterThan(0);
  });

  it("falls back to a usable name when given only whitespace", () => {
    const kit = generateBrandKit({ name: "   " });
    expect(kit.name).toBe("Untitled");
  });

  it("exposes the vibe vocabulary for the UI", () => {
    expect(KNOWN_VIBES).toContain("modern");
    expect(KNOWN_VIBES).toContain("luxury");
    expect(KNOWN_VIBES.length).toBeGreaterThan(10);
  });

  it("produces a complete v2 kit with all 11 sections", () => {
    const k = generateBrandKit({ name: "Northwind", industry: "fintech", vibe: ["modern", "bold"] });
    expect(k.meta.version).toBe("2.0");
    expect(k.strategy.mission).toContain("Northwind");
    expect(k.strategy.values.length).toBeGreaterThanOrEqual(3);
    expect(k.logo.primary.startsWith("<svg")).toBe(true);
    expect(k.logo.icon.startsWith("<svg")).toBe(true);
    expect(Object.keys(k.colors.ramps.primary)).toHaveLength(10);
    expect(k.colors.ratios.length).toBeGreaterThan(0);
    expect(k.typography.scale.length).toBeGreaterThan(5);
    expect(k.visual.icons.samples).toHaveLength(8);
    expect(k.visual.gradients.length).toBeGreaterThan(0);
    expect(k.imagery.photography.mood.length).toBeGreaterThan(0);
    expect(k.ui.buttons.length).toBe(4);
    expect(k.voiceKit.tone).toHaveLength(4);
    expect(k.social.handle.startsWith("@")).toBe(true);
    expect(k.social.templates.length).toBeGreaterThan(0);
    expect(k.marketing.emailSignature).toContain("<table");
    expect(k.guidelines.html).toContain("<!doctype html>");
    expect(k.exports.tailwind).toContain("module.exports");
    expect(k.exports.figmaTokens).toContain("$value");
  });

  it("is fully deterministic across the whole v2 kit", () => {
    const brief = { name: "Volt", industry: "energy", vibe: ["bold", "energetic"] };
    expect(generateBrandKit(brief)).toEqual(generateBrandKit({ ...brief }));
  });

  it("keeps every backward-compatible v1 field", () => {
    const k = generateBrandKit({ name: "Acme", vibe: ["modern"] });
    // The API and older callers still read these flat fields.
    expect(k.palette.primary).toMatch(HEX);
    expect(k.swatches).toHaveLength(6);
    expect(Array.isArray(k.voice)).toBe(true);
    expect(typeof k.cssVariables).toBe("string");
    expect(typeof k.tagline).toBe("string");
  });

  it("seedFromBrief is stable and unsigned", () => {
    const seed = seedFromBrief({ name: "Fixed", industry: "x", vibe: ["a"] });
    expect(seed).toBe(seedFromBrief({ name: "Fixed", industry: "x", vibe: ["a"] }));
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seed)).toBe(true);
  });
});
