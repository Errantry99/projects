import { CONFIG, type Config } from "../config.js";
import { clamp01, lerp, smoothstep } from "./math.js";

export type Rgb = readonly [number, number, number]; // 0..1
export type Lab = readonly [number, number, number]; // Oklab

export function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

export function rgbToLab(rgb: Rgb): Lab {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function labToRgb(lab: Lab): Rgb {
  const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    clamp01(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** Interpolate in Oklab so the fade is perceptually even, not sRGB-lumpy. */
export function mixHex(a: string, b: string, t: number): Lab {
  const A = rgbToLab(hexToRgb(a));
  const B = rgbToLab(hexToRgb(b));
  return [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
}

export function cssRgb(lab: Lab): string {
  const c = labToRgb(lab);
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

export function cssRgba(lab: Lab, alpha: number): string {
  const c = labToRgb(lab);
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha.toFixed(3)})`;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}

export function contrastRatio(y1: number, y2: number): number {
  const hi = Math.max(y1, y2);
  const lo = Math.min(y1, y2);
  return (hi + 0.05) / (lo + 0.05);
}

export interface Palette {
  readonly bg: Lab;
  readonly ink: Lab;
  /** 0..1 — how much legibility halo the letterforms need right now. */
  readonly halo: number;
  /** 0..1 — progress of the ink crossfade to ember, drives the bloom. */
  readonly ember: number;
  /** Measured contrast of ink against background at this depth. */
  readonly contrast: number;
}

/**
 * Where the ink crosses over from near-black to ember.
 *
 * The ink has to travel from dark to light while the background travels from
 * paper to black, so their luminances must cross somewhere — there is no
 * colour that contrasts with both grounds, and crossfading between the two
 * inks passes straight through the background's own luminance. Rather than
 * pick a lightness threshold by hand, solve for the depth at which the two
 * inks are equally legible: that is the least bad place for the crossing,
 * and a halo carries the words across it.
 */
export function solveCrossoverDepth(config: Config = CONFIG): number {
  const inkY = relativeLuminance(hexToRgb(config.inkSurface));
  const emberY = relativeLuminance(hexToRgb(config.inkEmber));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const bgY = relativeLuminance(labToRgb(mixHex(config.bgSurface, config.bgDeep, mid)));
    if (contrastRatio(bgY, inkY) < contrastRatio(bgY, emberY)) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function makePalette(config: Config = CONFIG): (depth: number) => Palette {
  const crossover = solveCrossoverDepth(config);
  const half = config.inkCrossWindow / 2;

  return (depth: number): Palette => {
    const bg = mixHex(config.bgSurface, config.bgDeep, depth);
    const ember = smoothstep(crossover - half, crossover + half, depth);
    const ink = mixHex(config.inkSurface, config.inkEmber, ember);
    const contrast = contrastRatio(
      relativeLuminance(labToRgb(ink)),
      relativeLuminance(labToRgb(bg)),
    );
    const halo = clamp01(
      (config.haloOnsetContrast - contrast) / (config.haloOnsetContrast - 1),
    );
    return { bg, ink, halo, ember, contrast };
  };
}
