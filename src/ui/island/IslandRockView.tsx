import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import styled from "styled-components";
import { playSounds } from "../../content/sounds";
import { rocksMiningService } from "../../services/rocksMiningService";
import { Sound } from "../../utils/gameModels";

const Container = styled.div<{
  $visible: boolean;
  $instant?: boolean;
  $disabled?: boolean;
}>`
  position: relative;
  display: inline-block;
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  transition: ${(p) => (p.$instant ? "none" : "opacity 260ms ease")};
  pointer-events: ${(p) => (p.$visible && !p.$disabled ? "auto" : "none")};
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  touch-action: none;
  -webkit-user-select: none;
  cursor: pointer;
`;

const RockImg = styled.img<{ $heightPct?: number; $hidden?: boolean }>`
  display: block;
  width: auto;
  height: ${(p) => (p.$heightPct ? `${p.$heightPct}%` : "auto")};
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
  user-select: none;
  -webkit-user-drag: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
  -webkit-touch-callout: none;
  filter: drop-shadow(0 5px 3px rgba(0, 0, 0, 0.28));
  cursor: pointer;
  -webkit-filter: drop-shadow(0 5px 3px rgba(0, 0, 0, 0.28));
`;

export function getRockImageUrl() {
  return rocksMiningService.getRockImageUrl();
}

type Props = {
  className?: string;
  onOpened?: () => void;
  onHit?: () => void;
  onBroken?: () => void;
  onBreakAnimationComplete?: () => void;
  heightPct?: number;
  src?: string;
};

export type IslandRockHandle = {
  tap: () => void;
};

const ROCK_BREAK_THRESHOLD = 7;
const ROCK_QUICK_WINDOW_MS = 320;
const ROCK_HEAL_GRACE_MS = 600;
const ROCK_HEAL_STEP_MS = 220;
const ROCK_MISS_BASE = 0.06;
const ROCK_MISS_SLOW_EXTRA = 0.1;

type ParticleFactoryResult = { el: SVGElement; onDone?: () => void };

type CrashParticleMeta = {
  gradient: SVGRadialGradientElement;
  stop0: SVGStopElement;
  stop1: SVGStopElement;
  stop2: SVGStopElement;
  star: SVGPolygonElement;
  angle: number;
  size: number;
  baseRot: number;
  spin: number;
  spread: number;
};

type CrashParticleElement = SVGGElement & { __meta: CrashParticleMeta };

const CRASH_COLOR_PALETTE = ["#FFF59D", "#FFE082", "#FFD54F"];

const IslandRock = forwardRef<IslandRockHandle, Props>(function IslandRock(
  {
    className,
    onOpened,
    onHit,
    onBroken,
    onBreakAnimationComplete,
    heightPct,
    src,
  },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const [instantHide, setInstantHide] = useState(false);
  const [hideRock, setHideRock] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const hitsRef = useRef(0);
  const lastClickRef = useRef<number | null>(null);
  const brokenRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const originRef = useRef<{ x: number; y: number }>({ x: 50, y: 50 });
  const unitRef = useRef<number>(15);
  const aspectRef = useRef<number>(1);
  const crashPoolRef = useRef<CrashParticleElement[]>([]);
  const crashPoolInitRef = useRef(false);

  const fallbackSrcRef = useRef<string | null>(null);
  if (fallbackSrcRef.current === null) {
    fallbackSrcRef.current = getRockImageUrl();
  }
  const resolvedSrc = src ?? fallbackSrcRef.current;

  useEffect(() => {
    function updateMetrics() {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) return;
      originRef.current = { x: 50, y: 39.5 };
      unitRef.current = 100;
      aspectRef.current = cr.height / cr.width;
    }
    updateMetrics();
    const ro = new ResizeObserver(() => updateMetrics());
    const node = containerRef.current;
    if (node) ro.observe(node);
    window.addEventListener("resize", updateMetrics);
    return () => {
      try {
        if (node) ro.unobserve(node);
      } catch {}
      window.removeEventListener("resize", updateMetrics);
    };
  }, []);

  useEffect(() => {
    if (crashPoolInitRef.current) return;
    crashPoolInitRef.current = true;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    function prepare() {
      if (typeof document === "undefined") return;
      const pool = crashPoolRef.current;
      const target = 24;
      for (let i = pool.length; i < target; i++) {
        pool.push(createCrashParticle());
      }
    }
    if (typeof window !== "undefined") {
      const win = window as any;
      if (typeof win.requestIdleCallback === "function") {
        idleHandle = win.requestIdleCallback(() => prepare());
      } else {
        timeoutHandle = window.setTimeout(prepare, 120);
      }
    }
    return () => {
      if (typeof window === "undefined") return;
      const win = window as any;
      if (idleHandle !== null && typeof win.cancelIdleCallback === "function") {
        win.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    };
  }, []);

  useImperativeHandle(ref, () => ({
    tap: () => {
      if (!visible || brokenRef.current) return;
      const now = Date.now();
      const last = lastClickRef.current;
      if (last !== null) {
        const since = now - last;
        if (since > ROCK_HEAL_GRACE_MS) {
          const healAmount =
            Math.floor((since - ROCK_HEAL_GRACE_MS) / ROCK_HEAL_STEP_MS) + 1;
          hitsRef.current = Math.max(0, hitsRef.current - healAmount);
        }
      }
      const sinceLast = last === null ? 0 : now - last;
      const isQuick = last === null || sinceLast <= ROCK_QUICK_WINDOW_MS;
      const missChance = ROCK_MISS_BASE + (isQuick ? 0 : ROCK_MISS_SLOW_EXTRA);
      const isMiss = Math.random() < missChance;

      try {
        onHit?.();
      } catch {}

      if (isMiss) {
        playSounds([Sound.PickaxeMiss]);
        showMissParticles();
        if (hitsRef.current > 0)
          hitsRef.current = Math.max(0, hitsRef.current - 1);
      } else {
        playSounds([Sound.PickaxeHit]);
        showHitParticles();
        if (isQuick) hitsRef.current += 1;
      }
      lastClickRef.current = now;
      if (hitsRef.current >= ROCK_BREAK_THRESHOLD) {
        brokenRef.current = true;
        playSounds([Sound.RockOpen]);
        setInstantHide(true);
        setHideRock(true);
        setDisabled(true);
        onBroken?.();
        showCrashParticles();
        hitsRef.current = 0;
        lastClickRef.current = null;
      }
    },
  }));

  function animateParticles(
    num: number,
    duration: number,
    make: (idx: number) => ParticleFactoryResult,
    update: (el: SVGElement, t: number, idx: number) => void,
    onComplete?: () => void,
  ) {
    const svg = svgRef.current;
    if (!svg) return;
    const parts: SVGElement[] = [];
    const cleanups: (undefined | (() => void))[] = [];
    for (let i = 0; i < num; i++) {
      const { el, onDone } = make(i);
      parts.push(el);
      cleanups.push(onDone);
      svg.appendChild(el);
    }
    const start = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      for (let i = 0; i < parts.length; i++) {
        update(parts[i], t, i);
      }
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        for (let i = 0; i < parts.length; i++) {
          const el = parts[i];
          el.remove();
          const done = cleanups[i];
          if (done) done();
        }
        if (onComplete) {
          try {
            onComplete();
          } catch {}
        }
      }
    }
    requestAnimationFrame(step);
  }

  function randAng(i: number, n: number) {
    return (i / n) * Math.PI * 2 + Math.random() * 0.3;
  }

  function showHitParticles() {
    animateParticles(
      14,
      190,
      (i) => {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const line = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        line.setAttribute(
          "stroke",
          Math.random() < 0.5 ? "#FFF59D" : "#FFE082",
        );
        line.setAttribute("stroke-linecap", "round");
        g.appendChild(line);
        const glow = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        glow.setAttribute("fill", "#FFF59D");
        g.appendChild(glow);
        const size = 0.1 + Math.random() * (0.18 - 0.1);
        g.setAttribute("data-s", size.toString());
        const tail = 1.1 + Math.random() * 0.8;
        g.setAttribute("data-tail", tail.toString());
        const angle = randAng(i, 14);
        g.setAttribute("data-a", angle.toString());
        return { el: g };
      },
      (g, t) => {
        const ease = Math.pow(t, 0.33);
        const angle = parseFloat(g.getAttribute("data-a") || "0");
        const unit = unitRef.current;
        const { x: ox, y: oy } = originRef.current;
        const maxDist = 1.0 * unit;
        const size = parseFloat(g.getAttribute("data-s") || "0.1");
        const r = size * 0.52 * unit;
        const baseOffset = r * 0.6;
        const dist = baseOffset + ease * maxDist;
        const x = ox + Math.cos(angle) * dist * aspectRef.current;
        const y = oy + Math.sin(angle) * dist;
        g.setAttribute(
          "transform",
          `translate(${x} ${y}) rotate(${(angle * 180) / Math.PI})`,
        );
        const line = g.firstChild as SVGLineElement;
        const tailFactor = parseFloat(g.getAttribute("data-tail") || "1");
        const len = r * tailFactor * 1.15;
        line.setAttribute("x1", (-len).toString());
        line.setAttribute("y1", "0");
        line.setAttribute("x2", "0");
        line.setAttribute("y2", "0");
        line.setAttribute(
          "stroke-width",
          Math.max(
            0.75,
            (0.022 * unit + size * unit * 0.05) * (1 - t * 0.35),
          ).toString(),
        );
        line.setAttribute(
          "opacity",
          Math.max(0, 0.96 * (1 - t * 0.8)).toString(),
        );
        const glow = g.lastChild as SVGCircleElement;
        glow.setAttribute("cx", "0");
        glow.setAttribute("cy", "0");
        glow.setAttribute("r", r.toString());
        glow.setAttribute(
          "opacity",
          Math.max(0, 0.85 * (1 - t * 0.7)).toString(),
        );
      },
    );
  }

  function showMissParticles() {
    animateParticles(
      10,
      220,
      () => {
        const rect = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        rect.setAttribute("fill", Math.random() < 0.5 ? "#A0A4AB" : "#8E949B");
        rect.setAttribute("stroke", "#6E737A");
        rect.setAttribute("stroke-width", "0.6");
        const size = 0.12 + Math.random() * (0.2 - 0.12);
        rect.setAttribute("data-s", size.toString());
        return { el: rect };
      },
      (rect, t, i) => {
        const ease = Math.pow(t, 0.45);
        const angle = randAng(i, 10);
        const unit = unitRef.current;
        const { x: ox, y: oy } = originRef.current;
        const maxDist = 0.8 * unit;
        const dist = ease * maxDist;
        const size = parseFloat(rect.getAttribute("data-s") || "0.08");
        const w = size * unit * (1 - t * 0.6);
        const cx = ox + Math.cos(angle) * dist * aspectRef.current;
        const cy = oy + Math.sin(angle) * dist;
        rect.setAttribute("x", (cx - w / 2).toString());
        rect.setAttribute("y", (cy - w / 2).toString());
        rect.setAttribute("width", w.toString());
        rect.setAttribute("height", w.toString());
        const rot = (angle * 180) / Math.PI + (Math.random() - 0.5) * 240 * t;
        rect.setAttribute("transform", `rotate(${rot} ${cx} ${cy})`);
        rect.setAttribute("opacity", (1 - t).toString());
      },
    );
  }

  function createCrashParticle(): CrashParticleElement {
    const ns = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(ns, "g") as CrashParticleElement;
    const defs = document.createElementNS(ns, "defs");
    g.appendChild(defs);
    const gradient = document.createElementNS(ns, "radialGradient");
    const gid = `crash-grad-${Math.random().toString(16).slice(2)}`;
    gradient.setAttribute("id", gid);
    const stop0 = document.createElementNS(ns, "stop");
    stop0.setAttribute("offset", "0%");
    stop0.setAttribute("stop-color", "#FFFFFF");
    const stop1 = document.createElementNS(ns, "stop");
    stop1.setAttribute("offset", "35%");
    stop1.setAttribute("stop-color", "#FFE082");
    const stop2 = document.createElementNS(ns, "stop");
    stop2.setAttribute("offset", "100%");
    gradient.appendChild(stop0);
    gradient.appendChild(stop1);
    gradient.appendChild(stop2);
    defs.appendChild(gradient);
    const star = document.createElementNS(ns, "polygon");
    star.setAttribute("fill", `url(#${gid})`);
    star.setAttribute("stroke", "none");
    star.setAttribute("stroke-linejoin", "round");
    g.appendChild(star);
    g.__meta = {
      gradient,
      stop0,
      stop1,
      stop2,
      star,
      angle: 0,
      size: 1,
      baseRot: 0,
      spin: 0,
      spread: 0,
    };
    return g;
  }

  function acquireCrashParticle(): CrashParticleElement {
    const pool = crashPoolRef.current;
    return pool.pop() ?? createCrashParticle();
  }

  function releaseCrashParticle(el: CrashParticleElement) {
    crashPoolRef.current.push(el);
  }

  function showCrashParticles() {
    animateParticles(
      20,
      460,
      () => {
        const g = acquireCrashParticle();
        const meta = g.__meta;
        const angle = Math.random() * Math.PI * 2;
        const size = 0.58 + Math.random() * (0.95 - 0.58);
        const longR = size * 0.95 * 50;
        const shortR = size * 0.45 * 50;
        const spikes = 6;
        const step = Math.PI / spikes;
        const points: string[] = [];
        for (let s = 0; s < spikes * 2; s++) {
          const r = s % 2 === 0 ? longR : shortR;
          const a = s * step;
          points.push(`${Math.cos(a) * r},${Math.sin(a) * r}`);
        }
        meta.stop2.setAttribute(
          "stop-color",
          CRASH_COLOR_PALETTE[
            Math.floor(Math.random() * CRASH_COLOR_PALETTE.length)
          ],
        );
        meta.star.setAttribute("points", points.join(" "));
        meta.angle = angle;
        meta.size = size;
        meta.baseRot = (angle * 180) / Math.PI + (Math.random() * 120 - 60);
        meta.spin = (Math.random() - 0.5) * 120;
        meta.spread = (1.7 + Math.random() * 0.6) * unitRef.current;
        g.removeAttribute("transform");
        g.setAttribute("opacity", "1");
        return { el: g, onDone: () => releaseCrashParticle(g) };
      },
      (node, t) => {
        const g = node as CrashParticleElement;
        const meta = g.__meta;
        const { x: ox, y: oy } = originRef.current;
        const progress = 1 - Math.pow(1 - t, 2.8);
        const tx =
          ox +
          Math.cos(meta.angle) * progress * meta.spread * aspectRef.current;
        const ty = oy + Math.sin(meta.angle) * progress * meta.spread;
        const rot = meta.baseRot + meta.spin * t;
        const growthThreshold = 0.15;
        const growthMultiplier = 3;
        const currentSize =
          meta.size * (t < growthThreshold ? 1 + t * growthMultiplier : 1);
        const scale = currentSize / meta.size;
        const fadeStart = 0.45;
        const localT = Math.max(0, (t - fadeStart) / (1 - fadeStart));
        const smooth = localT * localT * (3 - 2 * localT);
        const opacity = 1 - smooth;
        g.setAttribute(
          "transform",
          `translate(${tx} ${ty}) rotate(${rot}) scale(${scale})`,
        );
        g.setAttribute("opacity", Math.max(0, Math.min(1, opacity)).toString());
      },
      () => {
        onBreakAnimationComplete?.();
      },
    );
  }

  return (
    <Container
      ref={containerRef}
      className={className}
      $visible={visible}
      $instant={instantHide}
      $disabled={disabled}
    >
      <RockImg
        ref={imgElRef}
        src={resolvedSrc}
        alt=""
        draggable={false}
        $heightPct={heightPct}
        $hidden={hideRock}
        onLoad={() => {
          setVisible(true);
          onOpened?.();
        }}
      />
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible",
        }}
      />
    </Container>
  );
});

export default IslandRock;
