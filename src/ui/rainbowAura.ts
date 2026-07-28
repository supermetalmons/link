import { colors } from "../content/boardStyles";

export const RAINBOW_AURA_SCALE = 1.27;
export const RAINBOW_AURA_OFFSET_PERCENT = -13.5;
export const RAINBOW_AURA_BLUR_PX = 2;
export const RAINBOW_AURA_OPACITY = 0.99;
export const RAINBOW_AURA_ROTATION_S = 12;
export const RAINBOW_AURA_ROTATOR_SIZE_PERCENT = 240;
const RAINBOW_AURA_MASK_CACHE_VARIANT = "mons-aura-mask=v1";

export function getRainbowAuraGradient(): string {
  const r: Record<string, string> = colors.rainbow as any;
  return `conic-gradient(${r[7]} 0deg, #0066ff 45deg, ${r[6]} 90deg, ${r[5]} 135deg, ${r[4]} 180deg, ${r[3]} 225deg, ${r[2]} 270deg, ${r[1]} 315deg, ${r[7]} 360deg)`;
}

export const RAINBOW_MASK_CSS_BASE = `-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-position:50% 50%;mask-position:50% 50%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`;

export function getRainbowAuraMaskUrl(src: string): string {
  if (!src || /^(?:blob|data):/i.test(src)) return src;

  const hashIndex = src.indexOf("#");
  const url = hashIndex === -1 ? src : src.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : src.slice(hashIndex);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${RAINBOW_AURA_MASK_CACHE_VARIANT}${hash}`;
}

function ensureRainbowAuraStylesInjected(): void {
  const id = "mons-rainbow-aura-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `@keyframes mons-rainbow-rotate{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.mons-rainbow-rotator{animation:none!important}}`;
  document.head.appendChild(style);
}

function createRainbowAuraElements(): {
  background: HTMLDivElement;
  inner: HTMLDivElement;
} {
  ensureRainbowAuraStylesInjected();
  const background = document.createElement("div");
  background.style.cssText = `position:absolute;z-index:1;width:${RAINBOW_AURA_SCALE * 100}%;height:${RAINBOW_AURA_SCALE * 100}%;top:${RAINBOW_AURA_OFFSET_PERCENT}%;left:${RAINBOW_AURA_OFFSET_PERCENT}%;filter:blur(${RAINBOW_AURA_BLUR_PX}px);opacity:${RAINBOW_AURA_OPACITY};pointer-events:none;visibility:hidden;overflow:visible;`;

  const inner = document.createElement("div");
  inner.style.cssText = `position:absolute;inset:0;${RAINBOW_MASK_CSS_BASE}pointer-events:none;overflow:visible;`;

  const wrap = document.createElement("div");
  wrap.style.cssText = `position:absolute;top:50%;left:50%;width:${RAINBOW_AURA_ROTATOR_SIZE_PERCENT}%;height:${RAINBOW_AURA_ROTATOR_SIZE_PERCENT}%;transform:translate(-50%,-50%);pointer-events:none;overflow:visible;`;

  const rotator = document.createElement("div");
  rotator.className = "mons-rainbow-rotator";
  rotator.style.cssText = `position:absolute;inset:0;background:${getRainbowAuraGradient()};will-change:transform;transform-origin:50% 50%;animation:mons-rainbow-rotate ${RAINBOW_AURA_ROTATION_S}s linear infinite;`;

  wrap.appendChild(rotator);
  inner.appendChild(wrap);
  background.appendChild(inner);
  return { background, inner };
}

export function attachRainbowAura(container: HTMLElement): {
  background: HTMLDivElement;
  inner: HTMLDivElement;
} {
  const { background, inner } = createRainbowAuraElements();
  container.appendChild(background);
  return { background, inner };
}

export function setRainbowAuraMask(inner: HTMLElement, src: string): void {
  const maskUrl = getRainbowAuraMaskUrl(src);
  inner.style.setProperty("-webkit-mask-image", `url(${maskUrl})`);
  inner.style.setProperty("mask-image", `url(${maskUrl})`);
}

export function showRainbowAura(background: HTMLElement): void {
  background.style.visibility = "visible";
}

export function hideRainbowAura(background: HTMLElement): void {
  background.style.visibility = "hidden";
}
