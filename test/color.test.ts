import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import {
  contrastRatio,
  cssRgb,
  hexToRgb,
  labToRgb,
  makePalette,
  mixHex,
  relativeLuminance,
  rgbToLab,
  solveCrossoverDepth,
} from "../src/core/color.js";

const sweep = (n = 200) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe("oklab", () => {
  it("round-trips a colour", () => {
    for (const hex of ["#F2E8DB", "#1A1714", "#8C7F6B", "#000000", "#FFFFFF"]) {
      const back = labToRgb(rgbToLab(hexToRgb(hex)));
      const orig = hexToRgb(hex);
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(orig[i] as number, 5);
    }
  });

  it("pins the endpoints of the descent", () => {
    expect(cssRgb(mixHex(CONFIG.bgSurface, CONFIG.bgDeep, 0))).toBe("rgb(242,232,219)");
    expect(cssRgb(mixHex(CONFIG.bgSurface, CONFIG.bgDeep, 1))).toBe("rgb(0,0,0)");
  });

  it("darkens monotonically in perceived lightness", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const d of sweep()) {
      const l = mixHex(CONFIG.bgSurface, CONFIG.bgDeep, d)[0];
      expect(l).toBeLessThanOrEqual(previous + 1e-9);
      previous = l;
    }
  });
});

describe("ink crossover", () => {
  it("solves for the depth where both inks are equally legible", () => {
    const crossover = solveCrossoverDepth();
    const bgY = relativeLuminance(labToRgb(mixHex(CONFIG.bgSurface, CONFIG.bgDeep, crossover)));
    const inkY = relativeLuminance(hexToRgb(CONFIG.inkSurface));
    const emberY = relativeLuminance(hexToRgb(CONFIG.inkEmber));
    expect(contrastRatio(bgY, inkY)).toBeCloseTo(contrastRatio(bgY, emberY), 2);
    expect(crossover).toBeGreaterThan(0.3);
    expect(crossover).toBeLessThan(0.8);
  });

  it("keeps the surface and deep states on their intended inks", () => {
    const palette = makePalette();
    expect(palette(0).ember).toBe(0);
    expect(palette(1).ember).toBe(1);
    expect(cssRgb(palette(0).ink)).toBe("rgb(26,23,20)");
    expect(cssRgb(palette(1).ink)).toBe("rgb(140,127,107)");
  });
});

describe("legibility across the whole descent", () => {
  // The defect this guards: ink and background luminance must cross somewhere,
  // and at the crossing the text is invisible. Measured on the unhaloed ink it
  // bottoms out near 1:1 — words genuinely disappear.
  it("confirms the ink alone is not enough", () => {
    const palette = makePalette();
    const worst = Math.min(...sweep().map((d) => palette(d).contrast));
    expect(worst).toBeLessThan(1.5);
  });

  it("holds at least 3:1 once the halo is counted", () => {
    const palette = makePalette();
    const haloY = relativeLuminance(hexToRgb(CONFIG.haloColor));
    let worst = Number.POSITIVE_INFINITY;
    let worstAt = 0;

    for (const d of sweep()) {
      const { contrast, halo, bg } = palette(d);
      const bgY = relativeLuminance(labToRgb(bg));
      // the halo composited over the background, in linear light
      const haloContrast = contrastRatio(halo * haloY + (1 - halo) * bgY, bgY);
      const legible = Math.max(contrast, haloContrast);
      if (legible < worst) {
        worst = legible;
        worstAt = d;
      }
    }
    expect(
      worst,
      `worst legibility ${worst.toFixed(2)}:1 at depth ${worstAt.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("asks for no halo on paper, and only a trace in the deep", () => {
    const palette = makePalette();
    expect(palette(0).halo).toBe(0); // 14.7:1 — nothing to rescue
    // Ember on black is 5.4:1, just under the onset, so a trace remains. It
    // sits under the bloom and is not separately visible; what matters is
    // that it is nowhere near the strength it reaches at the crossing.
    expect(palette(1).halo).toBeLessThan(0.2);
    expect(palette(1).halo).toBeLessThan(palette(solveCrossoverDepth()).halo / 4);
  });
});
