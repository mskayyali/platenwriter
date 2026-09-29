// Small shared helpers.
export const TAU = Math.PI * 2;
export const deg = d => d * Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOut = t => 1 - Math.pow(1 - t, 3);
export const linear = t => t;

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const randSeed = () => (Math.random() * 4294967296) >>> 0;
// stable per-character seed from a sheet seed and the character's index
export const mixSeed = (a, b) => { let h = (a ^ Math.imul(b + 0x9E3779B9, 0x85EBCA6B)) >>> 0; h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35); return (h ^ (h >>> 16)) >>> 0; };
// Every 2D canvas here is CPU-backed. They are read back (getImageData, texture uploads) and drawn
// into one another constantly; on a GPU-backed canvas each of those is a GPU→CPU readback, which in
// Safari stalls the frame. Taking the context first fixes its settings for every later getContext.
export function mkCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  c.getContext('2d', { willReadFrequently: true }); return c;
}
