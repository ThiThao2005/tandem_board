/**
 * Bảng màu lấy cảm hứng từ thiên nhiên: trời, lúa, rêu, đất nung, hoa thạch thảo, đá.
 * Mỗi tông có màu nền nhạt (bg), màu nhấn (accent) và màu chữ đậm (ink).
 */
export interface Tone {
  name: string;
  bg: string;
  accent: string;
  ink: string;
}

export const TONES: Tone[] = [
  { name: "trời", bg: "#e4eef2", accent: "#5b8fa8", ink: "#2f5a6e" },
  { name: "lúa", bg: "#f5ead2", accent: "#c08a2e", ink: "#7a5617" },
  { name: "rêu", bg: "#e3ecdc", accent: "#5d8a4e", ink: "#3a5a2f" },
  { name: "đất nung", bg: "#f5e1d7", accent: "#c0623f", ink: "#80381d" },
  { name: "thạch thảo", bg: "#ebe4ef", accent: "#8a6b9e", ink: "#58406a" },
  { name: "đá", bg: "#e9e6df", accent: "#7d7a70", ink: "#4d4b44" },
];

export const toneAt = (index: number): Tone => TONES[index % TONES.length]!;

/** Cùng một id luôn ra cùng một tông (dùng cho ô bảng, ô nhóm). */
export function toneFor(id: string): Tone {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return toneAt(h);
}

/** Biến CSS để gắn vào style của phần tử. */
export function toneVars(tone: Tone): Record<string, string> {
  return { "--tone-bg": tone.bg, "--tone-accent": tone.accent, "--tone-ink": tone.ink };
}
