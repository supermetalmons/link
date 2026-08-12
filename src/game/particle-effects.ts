import * as SVG from "../utils/svg";
import { Location } from "../utils/gameModels";
import { getBoardEffectsRuntime } from "./boardEffectsPort";

type ParticleConfig = {
  numParticles: number;
  duration: number;
  maxDistance: number;
  minParticleSize: number;
  maxParticleSize: number;
  createParticle: (
    centerX: number,
    centerY: number,
    size: number,
    angle: number,
    defs: SVGDefsElement,
    i: number,
    now: number,
  ) => {
    main: SVGElement;
    extra?: SVGElement;
    update: (
      x: number,
      y: number,
      size: number,
      opacity: number,
      t: number,
    ) => void;
    cleanup?: () => void;
  };
  fadeOutStrength?: number;
  sizeGrowthThreshold?: number;
  sizeGrowthMultiplier?: number;
  extraOpacityBoost?: number;
  ease?: (t: number) => number;
};

function inBoardCoordinates(location: Location): Location {
  const { isFlipped } = getBoardEffectsRuntime();
  if (isFlipped) {
    return new Location(10 - location.i, 10 - location.j);
  } else {
    return new Location(location.i, location.j);
  }
}

function spawnParticlesAt(
  at: Location,
  config: ParticleConfig,
  insertAtBeginning: boolean,
) {
  const location = inBoardCoordinates(at);
  const { effectsLayer } = getBoardEffectsRuntime();

  const group = document.createElementNS(SVG.ns, "g");
  group.style.pointerEvents = "none";
  if (insertAtBeginning && effectsLayer?.firstChild) {
    effectsLayer.insertBefore(group, effectsLayer.firstChild);
  } else {
    effectsLayer?.appendChild(group);
  }

  const centerX = location.j + 0.5;
  const centerY = location.i + 0.5;

  const defs = document.createElementNS(SVG.ns, "defs");
  group.appendChild(defs);

  const particles: Array<{
    main: SVGElement;
    extra?: SVGElement;
    angle: number;
    maxDistance: number;
    size: number;
    startTime: number;
    finished: boolean;
    update: (
      x: number,
      y: number,
      size: number,
      opacity: number,
      t: number,
    ) => void;
    cleanup?: () => void;
  }> = [];

  const now = performance.now();

  for (let i = 0; i < config.numParticles; i++) {
    const angle =
      (2 * Math.PI * i) / config.numParticles +
      Math.random() * (Math.PI / config.numParticles);
    const distance = config.maxDistance * (0.8 + Math.random() * 0.4);
    const size =
      config.minParticleSize +
      Math.random() * (config.maxParticleSize - config.minParticleSize);

    const { main, extra, update, cleanup } = config.createParticle(
      centerX,
      centerY,
      size,
      angle,
      defs,
      i,
      now,
    );

    group.appendChild(main);
    if (extra) group.appendChild(extra);

    particles.push({
      main,
      extra,
      angle,
      maxDistance: distance,
      size,
      startTime: now,
      finished: false,
      update,
      cleanup,
    });
  }

  function animateAllParticles(now: number) {
    let activeParticles = 0;
    for (const particle of particles) {
      if (particle.finished) continue;
      const elapsed = now - particle.startTime;
      const t = Math.min(elapsed / config.duration, 1);
      if (t >= 1) {
        if (particle.main.parentNode) {
          particle.main.parentNode.removeChild(particle.main);
        }
        if (particle.extra && particle.extra.parentNode) {
          particle.extra.parentNode.removeChild(particle.extra);
        }
        if (particle.cleanup) particle.cleanup();
        particle.finished = true;
      } else {
        const ease = config.ease || ((t: number) => 1 - Math.pow(1 - t, 4));
        const currentDistance = particle.maxDistance * ease(t);
        const x = centerX + Math.cos(particle.angle) * currentDistance;
        const y = centerY + Math.sin(particle.angle) * currentDistance;
        const fadeEase = Math.pow(t, 2);
        const opacity = 1 - fadeEase * (config.fadeOutStrength ?? 0.7);
        const sizeGrowth =
          config.sizeGrowthThreshold &&
          config.sizeGrowthMultiplier &&
          t < config.sizeGrowthThreshold
            ? t * config.sizeGrowthMultiplier
            : 1;
        const currentSize = particle.size * sizeGrowth;
        particle.update(x, y, currentSize, opacity, t);
        activeParticles++;
      }
    }

    if (activeParticles > 0) {
      requestAnimationFrame(animateAllParticles);
    } else {
      if (group.parentNode) {
        group.parentNode.removeChild(group);
      }
    }
  }

  requestAnimationFrame(animateAllParticles);
}

export function indicateElectricHit(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 12,
      duration: 250,
      maxDistance: 1.0,
      minParticleSize: 0.3,
      maxParticleSize: 0.7,
      fadeOutStrength: 0.9,
      ease: (t: number) => {
        const outward = Math.pow(t, 0.4);
        const crackling = Math.sin(t * 25) * 0.05 * (1 - t);
        return outward + crackling;
      },
      createParticle: (centerX, centerY, _size, angle, defs, i, now) => {
        const rotatePoint = (
          px: number,
          py: number,
          cosr: number,
          sinr: number,
        ) => {
          return [px * cosr - py * sinr, px * sinr + py * cosr];
        };

        const transformCommands = (
          commands: any[],
          cosr: number,
          sinr: number,
        ) => {
          return commands.map((cmd) => {
            if (cmd.type === "M" || cmd.type === "L") {
              const [nx, ny] = rotatePoint(cmd.x, cmd.y, cosr, sinr);
              return { type: cmd.type, x: nx, y: ny };
            }
            if (cmd.type === "Q") {
              const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, cosr, sinr);
              const [nx, ny] = rotatePoint(cmd.x, cmd.y, cosr, sinr);
              return { type: "Q", cx: ncx, cy: ncy, x: nx, y: ny };
            }
            return cmd;
          });
        };

        const buildD = (rotatedCommands: any[], tx: number, ty: number) => {
          return rotatedCommands
            .map((cmd) => {
              if (cmd.type === "M")
                return `M ${(cmd.x + tx).toString()} ${(cmd.y + ty).toString()}`;
              if (cmd.type === "L")
                return `L ${(cmd.x + tx).toString()} ${(cmd.y + ty).toString()}`;
              if (cmd.type === "Q")
                return `Q ${(cmd.cx + tx).toString()} ${(cmd.cy + ty).toString()} ${(cmd.x + tx).toString()} ${(cmd.y + ty).toString()}`;
              return cmd;
            })
            .join(" ");
        };

        const electricGradientId = `electric-gradient-${i}-${now}`;
        const gradient = document.createElementNS(SVG.ns, "linearGradient");
        gradient.setAttribute("id", electricGradientId);
        gradient.setAttribute("x1", "0%");
        gradient.setAttribute("y1", "0%");
        gradient.setAttribute("x2", "100%");
        gradient.setAttribute("y2", "0%");

        const coreStop = document.createElementNS(SVG.ns, "stop");
        coreStop.setAttribute("offset", "0%");
        coreStop.setAttribute("stop-color", "#FFFFFF");
        coreStop.setAttribute("stop-opacity", "1.0");
        gradient.appendChild(coreStop);

        const midStop = document.createElementNS(SVG.ns, "stop");
        midStop.setAttribute("offset", "30%");
        midStop.setAttribute("stop-color", "#FFFF99");
        midStop.setAttribute("stop-opacity", "0.95");
        gradient.appendChild(midStop);

        const electricStop = document.createElementNS(SVG.ns, "stop");
        electricStop.setAttribute("offset", "70%");
        electricStop.setAttribute("stop-color", "#FFD700");
        electricStop.setAttribute("stop-opacity", "0.85");
        gradient.appendChild(electricStop);

        const tipStop = document.createElementNS(SVG.ns, "stop");
        tipStop.setAttribute("offset", "100%");
        tipStop.setAttribute("stop-color", "#FFA500");
        tipStop.setAttribute("stop-opacity", "0.7");
        gradient.appendChild(tipStop);

        defs.appendChild(gradient);

        const container = document.createElementNS(SVG.ns, "g");
        container.style.pointerEvents = "none";
        container.style.overflow = "visible";

        const boltLength = 50 + Math.random() * 30;
        const segments = 6 + Math.floor(Math.random() * 4);
        const zigzagAmplitude = 12 + Math.random() * 10;
        const branchProbability = 0.4;
        const maxBranches = 2 + Math.floor(Math.random() * 3);

        const mainCommands: any[] = [];
        const mainPoints: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
        mainCommands.push({ type: "M", x: 0, y: 0 });

        for (let j = 1; j <= segments; j++) {
          const progress = j / segments;
          const x = progress * boltLength;
          const deviation = (Math.random() - 0.5) * 2;
          const y =
            Math.sin(progress * Math.PI * 3 + deviation) *
            zigzagAmplitude *
            (1 - progress * 0.3);
          mainPoints.push({ x, y });

          if (j === 1) {
            mainCommands.push({ type: "L", x, y });
          } else {
            const prevPoint = mainPoints[j - 1];
            const controlX =
              prevPoint.x +
              (x - prevPoint.x) * 0.6 +
              (Math.random() - 0.5) * 15;
            const controlY =
              prevPoint.y +
              (y - prevPoint.y) * 0.6 +
              (Math.random() - 0.5) * 15;
            mainCommands.push({ type: "Q", cx: controlX, cy: controlY, x, y });
          }
        }

        const rad = angle;
        const cosr = Math.cos(rad);
        const sinr = Math.sin(rad);
        const rotatedMain = transformCommands(mainCommands, cosr, sinr);

        const mainBolt = document.createElementNS(SVG.ns, "path");
        mainBolt.setAttribute("stroke", `url(#${electricGradientId})`);
        mainBolt.setAttribute(
          "stroke-width",
          (2 + Math.random() * 2).toString(),
        );
        mainBolt.setAttribute("stroke-linecap", "round");
        mainBolt.setAttribute("fill", "none");
        container.appendChild(mainBolt);

        const branches: { element: any; rotatedCommands: any[] }[] = [];
        let branchCount = 0;
        for (let j = 2; j < segments - 2 && branchCount < maxBranches; j++) {
          if (Math.random() < branchProbability) {
            const branchPoint = mainPoints[j];
            const branchLength = (30 + Math.random() * 40) * (1 - j / segments);
            const branchAngle = (Math.random() - 0.5) * Math.PI * 0.8;
            const branchSegments = 3 + Math.floor(Math.random() * 3);

            const branchCommands: any[] = [];
            branchCommands.push({
              type: "M",
              x: branchPoint.x,
              y: branchPoint.y,
            });
            for (let k = 1; k <= branchSegments; k++) {
              const branchProgress = k / branchSegments;
              const branchX =
                branchPoint.x +
                Math.cos(branchAngle) * branchLength * branchProgress;
              const branchY =
                branchPoint.y +
                Math.sin(branchAngle) * branchLength * branchProgress +
                (Math.random() - 0.5) * 10 * branchProgress;
              branchCommands.push({ type: "L", x: branchX, y: branchY });
            }

            const rotatedBranch = transformCommands(branchCommands, cosr, sinr);

            const branch = document.createElementNS(SVG.ns, "path");
            branch.setAttribute("stroke", `url(#${electricGradientId})`);
            branch.setAttribute("stroke-width", (1 + Math.random()).toString());
            branch.setAttribute("stroke-linecap", "round");
            branch.setAttribute("fill", "none");
            branch.setAttribute("opacity", "0.8");
            container.appendChild(branch);
            branches.push({ element: branch, rotatedCommands: rotatedBranch });
            branchCount++;
          }
        }

        const glow = document.createElementNS(SVG.ns, "path");
        glow.setAttribute("stroke", "#FFFF99");
        glow.setAttribute("stroke-width", (3 + Math.random() * 2).toString());
        glow.setAttribute("stroke-linecap", "round");
        glow.setAttribute("fill", "none");
        glow.setAttribute("opacity", "0.3");
        glow.style.filter = "blur(1px)";
        container.insertBefore(glow, mainBolt);

        const initialTx = centerX * 100;
        const initialTy = centerY * 100;
        mainBolt.setAttribute("d", buildD(rotatedMain, initialTx, initialTy));
        glow.setAttribute("d", buildD(rotatedMain, initialTx, initialTy));
        for (const b of branches) {
          b.element.setAttribute(
            "d",
            buildD(b.rotatedCommands, initialTx, initialTy),
          );
        }

        const crackleFrequency = 50 + Math.random() * 20;
        const intensityVariation = 0.6 + Math.random() * 0.4;
        const flickerOffset = Math.random() * Math.PI * 2;

        return {
          main: container,
          update: (x, y, _currentSize, opacity, t) => {
            const crackle =
              1 +
              Math.sin(t * crackleFrequency + flickerOffset) *
                intensityVariation;
            const secondary =
              1 +
              Math.sin(t * (crackleFrequency * 1.7) + flickerOffset + Math.PI) *
                0.3;
            const flicker = crackle * secondary;
            const spike = Math.random() < 0.1 ? 1.5 + Math.random() * 0.5 : 1;
            const electricOpacity = opacity * flicker * spike;
            const jitterX = (Math.random() - 0.5) * 3 * (1 - t);
            const jitterY = (Math.random() - 0.5) * 3 * (1 - t);
            const tx = x * 100 + jitterX;
            const ty = y * 100 + jitterY;
            mainBolt.setAttribute("d", buildD(rotatedMain, tx, ty));
            glow.setAttribute("d", buildD(rotatedMain, tx, ty));
            for (const b of branches) {
              b.element.setAttribute("d", buildD(b.rotatedCommands, tx, ty));
            }
            container.style.opacity = Math.max(
              0,
              Math.min(1, electricOpacity),
            ).toString();
            glow.setAttribute("opacity", (0.3 * flicker * opacity).toString());
          },
        };
      },
    },
    false,
  );
}

export function showPurpleBubbles(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 10,
      duration: 300,
      maxDistance: 1.5,
      minParticleSize: 0.15,
      maxParticleSize: 0.42,
      fadeOutStrength: 0.7,
      sizeGrowthThreshold: 0.2,
      sizeGrowthMultiplier: 5,
      extraOpacityBoost: 1.1,
      createParticle: (centerX, centerY, size, _angle, defs, i, now) => {
        const bubbleStops = [
          { offset: "0%", color: "#FFF0FA", opacity: "1.0" },
          { offset: "30%", color: "#F7B6E6", opacity: "0.98" },
          { offset: "70%", color: "#E6A3D7", opacity: "0.92" },
          { offset: "100%", color: "#D47FC2", opacity: "0.85" },
        ];
        const strokeColor = "#D47FC2";
        const glareColor = "#FFF0FA";
        const particleStrokeWidth = 1;
        const particleStrokeOpacity = 0.8;
        const glareSizeRatio = 0.3;
        const glareOffsetXRatio = 0.15;
        const glareOffsetYRatio = -0.1;
        const glareOpacity = 0.95;
        const glareOpacityBoost = 1.1;

        const particleId = `bubble-${i}-${now}`;

        const gradient = document.createElementNS(SVG.ns, "radialGradient");
        gradient.setAttribute("id", `gradient-${particleId}`);
        gradient.setAttribute("cx", "30%");
        gradient.setAttribute("cy", "25%");
        gradient.setAttribute("r", "70%");

        for (const stopDef of bubbleStops) {
          const stop = document.createElementNS(SVG.ns, "stop");
          stop.setAttribute("offset", stopDef.offset);
          stop.setAttribute("stop-color", stopDef.color);
          stop.setAttribute("stop-opacity", stopDef.opacity);
          gradient.appendChild(stop);
        }
        defs.appendChild(gradient);

        const particle = document.createElementNS(SVG.ns, "circle");
        particle.setAttribute("r", ((size / 2) * 100).toString());
        particle.setAttribute("cx", (centerX * 100).toString());
        particle.setAttribute("cy", (centerY * 100).toString());
        particle.setAttribute("fill", `url(#gradient-${particleId})`);
        particle.setAttribute("stroke", strokeColor);
        particle.setAttribute("stroke-width", particleStrokeWidth.toString());
        particle.setAttribute(
          "stroke-opacity",
          particleStrokeOpacity.toString(),
        );
        particle.style.pointerEvents = "none";
        particle.style.overflow = "visible";

        const glare = document.createElementNS(SVG.ns, "ellipse");
        const glareSize = size * glareSizeRatio;
        glare.setAttribute("rx", ((glareSize / 2) * 100).toString());
        glare.setAttribute("ry", ((glareSize / 3) * 100).toString());
        glare.setAttribute(
          "cx",
          ((centerX + size * glareOffsetXRatio) * 100).toString(),
        );
        glare.setAttribute(
          "cy",
          ((centerY + size * glareOffsetYRatio) * 100).toString(),
        );
        SVG.setFill(glare, glareColor);
        glare.setAttribute("opacity", glareOpacity.toString());
        glare.style.pointerEvents = "none";
        glare.style.overflow = "visible";

        return {
          main: particle,
          extra: glare,
          update: (x, y, currentSize, opacity) => {
            particle.setAttribute("cx", (x * 100).toString());
            particle.setAttribute("cy", (y * 100).toString());
            particle.setAttribute("r", ((currentSize / 2) * 100).toString());
            particle.style.opacity = opacity.toString();
            const glareSize = currentSize * glareSizeRatio;
            const glareOpacityCurrent = Math.min(
              1,
              opacity * glareOpacityBoost,
            );
            glare.setAttribute(
              "cx",
              ((x + currentSize * glareOffsetXRatio) * 100).toString(),
            );
            glare.setAttribute(
              "cy",
              ((y + currentSize * glareOffsetYRatio) * 100).toString(),
            );
            glare.setAttribute("rx", ((glareSize / 2) * 100).toString());
            glare.setAttribute("ry", ((glareSize / 3) * 100).toString());
            glare.style.opacity = glareOpacityCurrent.toString();
          },
        };
      },
    },
    true,
  );
}

export function indicateBombExplosion(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 22,
      duration: 280,
      maxDistance: 2.6,
      minParticleSize: 0.19,
      maxParticleSize: 0.42,
      fadeOutStrength: 0.95,
      sizeGrowthThreshold: 0.1,
      sizeGrowthMultiplier: 8,
      ease: (t: number) => {
        return 1 - Math.pow(1 - t, 3.2);
      },
      createParticle: (centerX, centerY, size, angle, defs, i, now) => {
        const gradientId = `burst-gradient-${i}-${now}`;
        const gradient = document.createElementNS(SVG.ns, "radialGradient");
        gradient.setAttribute("id", gradientId);
        gradient.setAttribute("cx", "50%");
        gradient.setAttribute("cy", "50%");
        gradient.setAttribute("r", "60%");
        const stop1 = document.createElementNS(SVG.ns, "stop");
        stop1.setAttribute("offset", "0%");
        stop1.setAttribute("stop-color", "#FFFFFF");
        stop1.setAttribute("stop-opacity", "1.0");
        const stop2 = document.createElementNS(SVG.ns, "stop");
        stop2.setAttribute("offset", "28%");
        stop2.setAttribute("stop-color", "#FFEFA3");
        stop2.setAttribute("stop-opacity", "0.98");
        const stop3 = document.createElementNS(SVG.ns, "stop");
        stop3.setAttribute("offset", "55%");
        stop3.setAttribute("stop-color", "#FFC940");
        stop3.setAttribute("stop-opacity", "0.98");
        const stop4 = document.createElementNS(SVG.ns, "stop");
        stop4.setAttribute("offset", "78%");
        stop4.setAttribute("stop-color", "#FF6A1E");
        stop4.setAttribute("stop-opacity", "0.97");
        const stop5 = document.createElementNS(SVG.ns, "stop");
        stop5.setAttribute("offset", "100%");
        stop5.setAttribute("stop-color", "#FF2E00");
        stop5.setAttribute("stop-opacity", "0.96");
        gradient.appendChild(stop1);
        gradient.appendChild(stop2);
        gradient.appendChild(stop3);
        gradient.appendChild(stop4);
        gradient.appendChild(stop5);
        defs.appendChild(gradient);

        const container = document.createElementNS(SVG.ns, "g");
        container.style.pointerEvents = "none";
        container.style.overflow = "visible";

        const star = document.createElementNS(SVG.ns, "polygon");
        star.setAttribute("fill", `url(#${gradientId})`);
        star.setAttribute("stroke", "#FF6A1E");
        star.setAttribute("stroke-width", "3");
        star.setAttribute("stroke-linejoin", "round");

        const core = document.createElementNS(SVG.ns, "circle");
        core.setAttribute("cx", "0");
        core.setAttribute("cy", "0");
        core.setAttribute("r", (size * 0.26 * 100).toString());
        core.setAttribute("fill", "#FFFFFF");
        core.setAttribute("opacity", "0.9");

        container.appendChild(star);
        container.appendChild(core);

        const spikes = 8 + Math.floor(Math.random() * 3);
        const longR = size * (0.62 + Math.random() * 0.22);
        const shortR = size * (0.34 + Math.random() * 0.12);
        const step = (2 * Math.PI) / spikes;
        const angleOffset = Math.random() * Math.PI * 2;
        const offsetX = (Math.random() - 0.5) * size * 0.05 * 100;
        const offsetY = (Math.random() - 0.5) * size * 0.05 * 100;

        const buildPoints = () => {
          const pts: string[] = [];
          for (let s = 0; s < spikes; s++) {
            const baseA = angleOffset + s * step;
            const aLong = baseA + (Math.random() - 0.5) * step * 0.12;
            const aShort =
              baseA + step / 2 + (Math.random() - 0.5) * step * 0.1;
            const rLongVar = longR * (0.92 + Math.random() * 0.22);
            const rShortVar = shortR * (0.9 + Math.random() * 0.18);
            const xL = Math.cos(aLong) * rLongVar * 100 + offsetX;
            const yL = Math.sin(aLong) * rLongVar * 100 + offsetY;
            const xS = Math.cos(aShort) * rShortVar * 100 + offsetX;
            const yS = Math.sin(aShort) * rShortVar * 100 + offsetY;
            pts.push(`${xL.toString()},${yL.toString()}`);
            pts.push(`${xS.toString()},${yS.toString()}`);
          }
          return pts.join(" ");
        };

        star.setAttribute("points", buildPoints());

        const baseRotation =
          (angle * 180) / Math.PI + (Math.random() * 160 - 80);
        const spin = (Math.random() - 0.5) * 70;
        container.setAttribute(
          "transform",
          `translate(${(centerX * 100).toString()} ${(centerY * 100).toString()}) rotate(${baseRotation.toString()}) scale(1)`,
        );

        return {
          main: container,
          update: (x, y, currentSize, opacity, t) => {
            const tx = x * 100;
            const ty = y * 100;
            const scale = currentSize / size;
            const rot = baseRotation + spin * t;
            container.setAttribute(
              "transform",
              `translate(${tx.toString()} ${ty.toString()}) rotate(${rot.toString()}) scale(${scale.toString()})`,
            );
            container.style.opacity = Math.max(
              0,
              Math.min(1, opacity * 1.1),
            ).toString();
            const coreR = currentSize * (0.28 - 0.16 * t) * 100;
            core.setAttribute("r", Math.max(0, coreR).toString());
            core.setAttribute("opacity", (opacity * 0.85).toString());
          },
        };
      },
    },
    false,
  );
}

export function indicateFlameGround(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 15,
      duration: 300,
      maxDistance: 1.8,
      minParticleSize: 0.22,
      maxParticleSize: 0.42,
      fadeOutStrength: 0.9,
      sizeGrowthThreshold: 0.3,
      sizeGrowthMultiplier: 2.5,
      ease: (t: number) => {
        const outward = Math.pow(t, 0.5);
        const wiggle = Math.sin(t * 8) * 0.1 * (1 - t);
        return outward + wiggle;
      },
      createParticle: (centerX, centerY, size, _angle, defs, i, now) => {
        const flameColors = [
          "#FF4500",
          "#FF6347",
          "#FF8C00",
          "#FFD700",
          "#FFA500",
          "#DC143C",
          "#FF2500",
          "#FF4000",
          "#FF6600",
        ];
        const coreColor = flameColors[i % flameColors.length];
        const outerColor = i % 3 === 0 ? "#FF4500" : "#FF8C00";

        const flameGradientId = `flame-gradient-${i}-${now}`;
        const gradient = document.createElementNS(SVG.ns, "radialGradient");
        gradient.setAttribute("id", flameGradientId);
        gradient.setAttribute("cx", "50%");
        gradient.setAttribute("cy", "70%");
        gradient.setAttribute("r", "80%");

        const coreStop = document.createElementNS(SVG.ns, "stop");
        coreStop.setAttribute("offset", "0%");
        coreStop.setAttribute("stop-color", "#FFFF00");
        coreStop.setAttribute("stop-opacity", "0.9");
        gradient.appendChild(coreStop);

        const midStop = document.createElementNS(SVG.ns, "stop");
        midStop.setAttribute("offset", "40%");
        midStop.setAttribute("stop-color", coreColor);
        midStop.setAttribute("stop-opacity", "0.8");
        gradient.appendChild(midStop);

        const outerStop = document.createElementNS(SVG.ns, "stop");
        outerStop.setAttribute("offset", "100%");
        outerStop.setAttribute("stop-color", outerColor);
        outerStop.setAttribute("stop-opacity", "0.3");
        gradient.appendChild(outerStop);

        defs.appendChild(gradient);
        const flame = document.createElementNS(SVG.ns, "path");
        const flameWidth = size * 1.2;
        const flameHeight = size * 1.6;
        const asymmetryFactor = (Math.random() - 0.5) * 0.4;
        const tipVariation = (Math.random() - 0.5) * 0.3;
        const baseVariation = (Math.random() - 0.5) * 0.2;
        const leftCurve = 0.5 + (Math.random() - 0.5) * 0.6;
        const rightCurve = 0.5 + (Math.random() - 0.5) * 0.6;
        const midBulge = 0.8 + (Math.random() - 0.5) * 0.4;
        const leftCtrl1 = 0.2 + (Math.random() - 0.5) * 0.15;
        const leftCtrl2 = 0.6 + (Math.random() - 0.5) * 0.2;
        const leftCtrl3 = 0.9 + (Math.random() - 0.5) * 0.15;
        const rightCtrl1 = 0.2 + (Math.random() - 0.5) * 0.15;
        const rightCtrl2 = 0.6 + (Math.random() - 0.5) * 0.2;
        const rightCtrl3 = 0.9 + (Math.random() - 0.5) * 0.15;
        const halfWidth = flameWidth / 2;
        const tipX = centerX + tipVariation * halfWidth;
        const tipY = centerY - flameHeight / 2.2;

        const pathData = `M ${tipX * 100} ${tipY * 100} 
                        C ${(centerX - halfWidth * leftCtrl1 + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (2.5 + Math.random() * 0.5)) * 100}, 
                          ${(centerX - halfWidth * leftCtrl2 * leftCurve + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (4 + Math.random() * 0.5)) * 100}, 
                          ${(centerX - halfWidth * leftCtrl3 * midBulge + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (8 + Math.random() * 0.3)) * 100}
                        C ${(centerX - halfWidth * (1.1 + Math.random() * 0.2) * midBulge + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (8 + Math.random() * 0.3)) * 100},
                          ${(centerX - halfWidth * (0.8 + Math.random() * 0.2) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (3 + Math.random() * 0.4)) * 100},
                          ${(centerX - halfWidth * (0.5 + baseVariation) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (2.2 + Math.random() * 0.3)) * 100}
                        C ${(centerX - halfWidth * (0.1 + Math.random() * 0.1) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (2 + Math.random() * 0.2)) * 100},
                          ${(centerX + halfWidth * (0.1 + Math.random() * 0.1) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (2 + Math.random() * 0.2)) * 100},
                          ${(centerX + halfWidth * (0.5 + baseVariation) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (2.2 + Math.random() * 0.3)) * 100}
                        C ${(centerX + halfWidth * (0.8 + Math.random() * 0.2) + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (3 + Math.random() * 0.4)) * 100},
                          ${(centerX + halfWidth * (1.1 + Math.random() * 0.2) * midBulge + asymmetryFactor * halfWidth) * 100} ${(centerY + flameHeight / (8 + Math.random() * 0.3)) * 100},
                          ${(centerX + halfWidth * rightCtrl3 * midBulge + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (8 + Math.random() * 0.3)) * 100}
                        C ${(centerX + halfWidth * rightCtrl2 * rightCurve + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (4 + Math.random() * 0.5)) * 100}, 
                          ${(centerX + halfWidth * rightCtrl1 + asymmetryFactor * halfWidth) * 100} ${(centerY - flameHeight / (2.5 + Math.random() * 0.5)) * 100}, 
                          ${tipX * 100} ${tipY * 100} Z`;

        flame.setAttribute("d", pathData);
        flame.setAttribute("fill", `url(#${flameGradientId})`);
        flame.style.pointerEvents = "none";
        flame.style.overflow = "visible";
        const flickerOffset = Math.random() * Math.PI * 2;
        const flickerSpeed = 12 + Math.random() * 8;
        const lateralDrift = (Math.random() - 0.5) * 0.3;

        return {
          main: flame,
          update: (x, y, currentSize, opacity, t) => {
            const flicker =
              1 + Math.sin(t * flickerSpeed + flickerOffset) * 0.15;
            const lateralOffset =
              Math.sin(t * 12 + flickerOffset) * lateralDrift * (1 - t * 0.5);
            const flameX = x + lateralOffset * 0.3;
            const flameY = y;

            const flickerSize = currentSize * flicker;
            const flameWidth = flickerSize * 1.2;
            const flameHeight = flickerSize * 1.6 * (1 + t * 0.3);
            const halfWidth = flameWidth / 2;
            const animTipX = flameX + tipVariation * halfWidth;
            const animTipY = flameY - flameHeight / 2.2;
            const windEffect =
              Math.sin(t * 6 + flickerOffset) * 0.1 * (1 - t * 0.7);

            const pathData = `M ${animTipX * 100} ${animTipY * 100} 
                            C ${(flameX - halfWidth * leftCtrl1 + asymmetryFactor * halfWidth + windEffect) * 100} ${(flameY - flameHeight / 2.5) * 100}, 
                              ${(flameX - halfWidth * leftCtrl2 * leftCurve + asymmetryFactor * halfWidth + windEffect * 0.7) * 100} ${(flameY - flameHeight / 4) * 100}, 
                              ${(flameX - halfWidth * leftCtrl3 * midBulge + asymmetryFactor * halfWidth + windEffect * 0.5) * 100} ${(flameY - flameHeight / 8) * 100}
                            C ${(flameX - halfWidth * 1.1 * midBulge + asymmetryFactor * halfWidth + windEffect * 0.3) * 100} ${(flameY + flameHeight / 8) * 100},
                              ${(flameX - halfWidth * 0.8 + asymmetryFactor * halfWidth + windEffect * 0.2) * 100} ${(flameY + flameHeight / 3) * 100},
                              ${(flameX - halfWidth * (0.5 + baseVariation) + asymmetryFactor * halfWidth) * 100} ${(flameY + flameHeight / 2.2) * 100}
                            C ${(flameX - halfWidth * 0.1 + asymmetryFactor * halfWidth) * 100} ${(flameY + flameHeight / 2) * 100},
                              ${(flameX + halfWidth * 0.1 + asymmetryFactor * halfWidth) * 100} ${(flameY + flameHeight / 2) * 100},
                              ${(flameX + halfWidth * (0.5 + baseVariation) + asymmetryFactor * halfWidth) * 100} ${(flameY + flameHeight / 2.2) * 100}
                            C ${(flameX + halfWidth * 0.8 + asymmetryFactor * halfWidth + windEffect * 0.2) * 100} ${(flameY + flameHeight / 3) * 100},
                              ${(flameX + halfWidth * 1.1 * midBulge + asymmetryFactor * halfWidth + windEffect * 0.3) * 100} ${(flameY + flameHeight / 8) * 100},
                              ${(flameX + halfWidth * rightCtrl3 * midBulge + asymmetryFactor * halfWidth + windEffect * 0.5) * 100} ${(flameY - flameHeight / 8) * 100}
                            C ${(flameX + halfWidth * rightCtrl2 * rightCurve + asymmetryFactor * halfWidth + windEffect * 0.7) * 100} ${(flameY - flameHeight / 4) * 100}, 
                              ${(flameX + halfWidth * rightCtrl1 + asymmetryFactor * halfWidth + windEffect) * 100} ${(flameY - flameHeight / 2.5) * 100}, 
                              ${animTipX * 100} ${animTipY * 100} Z`;
            flame.setAttribute("d", pathData);
            const flickerOpacity = opacity * (0.7 + 0.3 * flicker);
            flame.style.opacity = Math.max(
              0,
              Math.min(1, flickerOpacity),
            ).toString();
          },
        };
      },
    },
    false,
  );
}

export function indicateSpiritAction(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 11,
      duration: 300,
      maxDistance: 1.5,
      minParticleSize: 0.275,
      maxParticleSize: 0.445,
      fadeOutStrength: 0.95,
      sizeGrowthThreshold: 0.25,
      sizeGrowthMultiplier: 2.2,
      ease: (t: number) => {
        const outward = Math.pow(t, 0.6);
        const swirl = Math.sin(t * 6) * 0.08 * (1 - t);
        return outward + swirl;
      },
      createParticle: (centerX, centerY, size, _angle, defs, i, now) => {
        const transformPoint = (
          px: number,
          py: number,
          s: number,
          cosr: number,
          sinr: number,
          tx: number,
          ty: number,
        ) => {
          px *= s;
          py *= s;
          const px2 = px * cosr - py * sinr;
          const py2 = px * sinr + py * cosr;
          return [px2 + tx, py2 + ty];
        };

        const transformCommands = (
          commands: any[],
          scale: number,
          rotation: number,
          tx: number,
          ty: number,
        ) => {
          const rad = (rotation * Math.PI) / 180;
          const cosr = Math.cos(rad);
          const sinr = Math.sin(rad);
          return commands.map((cmd) => {
            if (cmd.type === "Z") return { type: "Z" };
            if (cmd.type === "M") {
              const [nx, ny] = transformPoint(
                cmd.x,
                cmd.y,
                scale,
                cosr,
                sinr,
                tx,
                ty,
              );
              return { type: "M", x: nx, y: ny };
            }
            if (cmd.type === "C") {
              const [nx1, ny1] = transformPoint(
                cmd.x1,
                cmd.y1,
                scale,
                cosr,
                sinr,
                tx,
                ty,
              );
              const [nx2, ny2] = transformPoint(
                cmd.x2,
                cmd.y2,
                scale,
                cosr,
                sinr,
                tx,
                ty,
              );
              const [nx3, ny3] = transformPoint(
                cmd.x3,
                cmd.y3,
                scale,
                cosr,
                sinr,
                tx,
                ty,
              );
              return {
                type: "C",
                x1: nx1,
                y1: ny1,
                x2: nx2,
                y2: ny2,
                x3: nx3,
                y3: ny3,
              };
            }
            return cmd;
          });
        };

        const commandsToD = (commands: any[]) => {
          return commands
            .map((cmd) => {
              if (cmd.type === "Z") return "Z";
              if (cmd.type === "M")
                return `M ${(cmd.x * 100).toString()} ${(cmd.y * 100).toString()}`;
              if (cmd.type === "C")
                return `C ${(cmd.x1 * 100).toString()} ${(cmd.y1 * 100).toString()} ${(cmd.x2 * 100).toString()} ${(cmd.y2 * 100).toString()} ${(cmd.x3 * 100).toString()} ${(cmd.y3 * 100).toString()}`;
              return cmd;
            })
            .join(" ");
        };

        const addBlob = (
          commands: any[],
          bx: number,
          by: number,
          radius: number,
          ox: number,
          oy: number,
        ) => {
          commands.push({ type: "M", x: bx - radius + ox, y: by + oy });
          commands.push({
            type: "C",
            x1: bx - radius + ox,
            y1: by - radius * 0.7 + oy,
            x2: bx - radius * 0.7 + ox,
            y2: by - radius + oy,
            x3: bx + ox,
            y3: by - radius + oy,
          });
          commands.push({
            type: "C",
            x1: bx + radius * 0.7 + ox,
            y1: by - radius + oy,
            x2: bx + radius + ox,
            y2: by - radius * 0.7 + oy,
            x3: bx + radius + ox,
            y3: by + oy,
          });
          commands.push({
            type: "C",
            x1: bx + radius + ox,
            y1: by + radius * 0.7 + oy,
            x2: bx + radius * 0.7 + ox,
            y2: by + radius + oy,
            x3: bx + ox,
            y3: by + radius + oy,
          });
          commands.push({
            type: "C",
            x1: bx - radius * 0.7 + ox,
            y1: by + radius + oy,
            x2: bx - radius + ox,
            y2: by + radius * 0.7 + oy,
            x3: bx - radius + ox,
            y3: by + oy,
          });
          commands.push({ type: "Z" });
        };

        const commands: any[] = [];
        const cloudWidth = size * (1.8 + Math.random() * 0.9);
        const puffCount = 4 + Math.floor(Math.random() * 2);
        const puffSize = cloudWidth / (puffCount * 1.2);
        const gradientId = `cloud-gradient-${i}-${now}`;
        const baseX = 0;
        const baseY = 0;

        const centerRadius = puffSize * (1.1 + Math.random() * 0.5);
        const centerOffsetX = puffSize * (Math.random() * 0.4 - 0.2);
        const centerOffsetY = puffSize * (Math.random() * 0.3 - 0.15);
        addBlob(
          commands,
          baseX,
          baseY,
          centerRadius,
          centerOffsetX,
          centerOffsetY,
        );

        for (let i = 0; i < puffCount; i++) {
          const angle = (i / puffCount) * Math.PI * 2;
          const distance = puffSize * (0.8 + Math.random() * 0.6);
          const x = baseX + Math.cos(angle) * distance;
          const y = baseY + Math.sin(angle) * distance;
          const radius = puffSize * (0.8 + Math.random() * 0.6);
          const offsetX = puffSize * (Math.random() * 0.4 - 0.2);
          const offsetY = puffSize * (Math.random() * 0.3 - 0.15);
          addBlob(commands, x, y, radius, offsetX, offsetY);
        }

        const cloud = document.createElementNS(SVG.ns, "path");
        cloud.setAttribute("fill", `url(#${gradientId})`);
        cloud.setAttribute("stroke", "#FFFFFF");
        cloud.setAttribute("stroke-width", "0.4");
        cloud.setAttribute("stroke-opacity", "0.08");
        cloud.style.pointerEvents = "none";
        cloud.style.overflow = "visible";

        const gradient = document.createElementNS(SVG.ns, "radialGradient");
        gradient.setAttribute("id", gradientId);
        gradient.setAttribute("gradientUnits", "userSpaceOnUse");
        gradient.setAttribute("cx", "50%");
        gradient.setAttribute("cy", "45%");
        gradient.setAttribute("r", "85%");
        const stop1 = document.createElementNS(SVG.ns, "stop");
        stop1.setAttribute("offset", "0%");
        stop1.setAttribute("stop-color", "#FFFFFF");
        stop1.setAttribute("stop-opacity", "0.6");
        const stop2 = document.createElementNS(SVG.ns, "stop");
        stop2.setAttribute("offset", "40%");
        stop2.setAttribute("stop-color", "#F8FBFF");
        stop2.setAttribute("stop-opacity", "0.55");
        const stop3 = document.createElementNS(SVG.ns, "stop");
        stop3.setAttribute("offset", "100%");
        stop3.setAttribute("stop-color", "#E8F4F8");
        stop3.setAttribute("stop-opacity", "0.42");
        gradient.appendChild(stop1);
        gradient.appendChild(stop2);
        gradient.appendChild(stop3);
        defs.appendChild(gradient);

        const windStrength = 0.25 + Math.random() * 0.35;
        const windFrequency = 6 + Math.random() * 3;
        const windPhase = Math.random() * Math.PI * 2;
        const floatFrequency = 3 + Math.random() * 2;
        const floatAmplitude = 0.12 + Math.random() * 0.08;

        const computeEffects = (t: number) => {
          const windEffect =
            Math.sin(t * windFrequency * Math.PI * 2 + windPhase) *
            windStrength;
          const floatEffect =
            Math.sin(t * floatFrequency * Math.PI * 2) * floatAmplitude;
          const rotation = windEffect * 12;
          const scale = 0.85 + floatEffect * 0.15;
          return { rotation, scale };
        };

        const setTransform = (
          x: number,
          y: number,
          rotation: number,
          scale: number,
        ) => {
          const transformed = transformCommands(
            commands,
            scale,
            rotation,
            x,
            y,
          );
          cloud.setAttribute("d", commandsToD(transformed));
        };

        const { rotation: initialRotation, scale: initialScale } =
          computeEffects(0);
        setTransform(centerX, centerY, initialRotation, initialScale);

        return {
          main: cloud,
          update: (x, y, _currentSize, opacity, t) => {
            const { rotation, scale } = computeEffects(t);
            setTransform(x, y, rotation, scale);
            cloud.style.opacity = (opacity * scale).toString();
          },
        };
      },
    },
    false,
  );
}

export function indicateWaterSplash(at: Location) {
  spawnParticlesAt(
    at,
    {
      numParticles: 10,
      duration: 230,
      maxDistance: 0.95,
      minParticleSize: 0.1,
      maxParticleSize: 0.15,
      fadeOutStrength: 0.6,
      sizeGrowthThreshold: 0.1,
      sizeGrowthMultiplier: 1.5,
      ease: (t: number) => {
        const outward = Math.pow(t, 0.7);
        const gentleFloat = Math.sin(t * Math.PI) * 0.2;
        return outward + gentleFloat;
      },
      createParticle: (centerX, centerY, size, angle, defs, i, now) => {
        const vibrantWaterColors = [
          "#35D2F8",
          "#B2F9FD",
          "#6EEBFA",
          "#A0F3F9",
          "#35D2F8",
          "#B2F9FD",
        ];
        const dropletColor = vibrantWaterColors[i % vibrantWaterColors.length];
        const isSpecialDroplet = size > 0.2;
        const gradientId = `water-droplet-gradient-${i}-${now}`;
        const gradient = document.createElementNS(SVG.ns, "radialGradient");
        gradient.setAttribute("id", gradientId);
        gradient.setAttribute("cx", "30%");
        gradient.setAttribute("cy", "20%");
        gradient.setAttribute("r", "70%");

        const highlightStop = document.createElementNS(SVG.ns, "stop");
        highlightStop.setAttribute("offset", "0%");
        highlightStop.setAttribute("stop-color", "#FFFFFF");
        highlightStop.setAttribute("stop-opacity", "1.0");
        gradient.appendChild(highlightStop);

        const midStop = document.createElementNS(SVG.ns, "stop");
        midStop.setAttribute("offset", "40%");
        midStop.setAttribute("stop-color", "#B2F9FD");
        midStop.setAttribute("stop-opacity", "0.95");
        gradient.appendChild(midStop);

        const colorStop = document.createElementNS(SVG.ns, "stop");
        colorStop.setAttribute("offset", "70%");
        colorStop.setAttribute("stop-color", "#35D2F8");
        colorStop.setAttribute("stop-opacity", "0.9");
        gradient.appendChild(colorStop);

        const edgeStop = document.createElementNS(SVG.ns, "stop");
        edgeStop.setAttribute("offset", "100%");
        edgeStop.setAttribute("stop-color", dropletColor);
        edgeStop.setAttribute("stop-opacity", "0.8");
        gradient.appendChild(edgeStop);

        defs.appendChild(gradient);

        const dropletWidth = size * (0.8 + Math.random() * 0.2);
        const dropletHeight = size * (1.2 + Math.random() * 0.2);
        const pathData = `M ${centerX * 100} ${(centerY - dropletHeight * 0.5) * 100}
                         C ${(centerX - dropletWidth * 0.2) * 100} ${(centerY - dropletHeight * 0.35) * 100},
                           ${(centerX - dropletWidth * 0.4) * 100} ${(centerY - dropletHeight * 0.1) * 100},
                           ${(centerX - dropletWidth * 0.45) * 100} ${(centerY + dropletHeight * 0.1) * 100}
                         C ${(centerX - dropletWidth * 0.5) * 100} ${(centerY + dropletHeight * 0.3) * 100},
                           ${(centerX - dropletWidth * 0.35) * 100} ${(centerY + dropletHeight * 0.45) * 100},
                           ${centerX * 100} ${(centerY + dropletHeight * 0.5) * 100}
                         C ${(centerX + dropletWidth * 0.35) * 100} ${(centerY + dropletHeight * 0.45) * 100},
                           ${(centerX + dropletWidth * 0.5) * 100} ${(centerY + dropletHeight * 0.3) * 100},
                           ${(centerX + dropletWidth * 0.45) * 100} ${(centerY + dropletHeight * 0.1) * 100}
                         C ${(centerX + dropletWidth * 0.4) * 100} ${(centerY - dropletHeight * 0.1) * 100},
                           ${(centerX + dropletWidth * 0.2) * 100} ${(centerY - dropletHeight * 0.35) * 100},
                           ${centerX * 100} ${(centerY - dropletHeight * 0.5) * 100} Z`;

        const droplet = document.createElementNS(SVG.ns, "path");
        droplet.setAttribute("d", pathData);
        droplet.setAttribute("fill", `url(#${gradientId})`);
        droplet.setAttribute("stroke", dropletColor);
        droplet.setAttribute("stroke-width", "1");
        droplet.setAttribute("stroke-opacity", "0.23");
        droplet.setAttribute("opacity", "0.78");
        droplet.style.pointerEvents = "none";
        droplet.style.overflow = "visible";

        let sparkle: SVGElement | undefined;
        if (isSpecialDroplet) {
          sparkle = document.createElementNS(SVG.ns, "ellipse");
          sparkle.setAttribute("rx", (size * 0.08 * 100).toString());
          sparkle.setAttribute("ry", (size * 0.05 * 100).toString());
          sparkle.setAttribute("cx", (centerX * 100).toString());
          sparkle.setAttribute("cy", (centerY * 100).toString());
          sparkle.setAttribute("fill", "#FFFFFF");
          sparkle.setAttribute("opacity", "0.6");
          sparkle.style.pointerEvents = "none";
          sparkle.style.overflow = "visible";
        }

        const velocityX = Math.cos(angle) * (0.3 + Math.random() * 0.2);
        const velocityY = Math.sin(angle) * (0.3 + Math.random() * 0.2);
        const gravity = 0.0098;
        const airResistance = 0;

        return {
          main: droplet,
          extra: sparkle,
          update: (x, y, currentSize, opacity, t) => {
            const currentVelX = velocityX * (1 - airResistance * t);
            const currentVelY = velocityY + gravity * t;
            const currentX = x + currentVelX * t;
            const currentY = y + currentVelY * t;
            const speed = Math.sqrt(
              currentVelX * currentVelX + currentVelY * currentVelY,
            );
            const stretch = 1 + speed * 0.3;
            const dropletWidth = currentSize * (1.0 + Math.random() * 0.1);
            const dropletHeight =
              currentSize * (1.4 + Math.random() * 0.1) * stretch;
            const motionAngle = Math.atan2(currentVelY, currentVelX);
            const rotationDegrees = (motionAngle * 180) / Math.PI - 90;
            const pathData = `M ${currentX * 100} ${(currentY - dropletHeight * 0.5) * 100}
                             C ${(currentX - dropletWidth * 0.2) * 100} ${(currentY - dropletHeight * 0.35) * 100},
                               ${(currentX - dropletWidth * 0.4) * 100} ${(currentY - dropletHeight * 0.1) * 100},
                               ${(currentX - dropletWidth * 0.45) * 100} ${(currentY + dropletHeight * 0.1) * 100}
                             C ${(currentX - dropletWidth * 0.5) * 100} ${(currentY + dropletHeight * 0.3) * 100},
                               ${(currentX - dropletWidth * 0.35) * 100} ${(currentY + dropletHeight * 0.45) * 100},
                               ${currentX * 100} ${(currentY + dropletHeight * 0.5) * 100}
                             C ${(currentX + dropletWidth * 0.35) * 100} ${(currentY + dropletHeight * 0.45) * 100},
                               ${(currentX + dropletWidth * 0.5) * 100} ${(currentY + dropletHeight * 0.3) * 100},
                               ${(currentX + dropletWidth * 0.45) * 100} ${(currentY + dropletHeight * 0.1) * 100}
                             C ${(currentX + dropletWidth * 0.4) * 100} ${(currentY - dropletHeight * 0.1) * 100},
                               ${(currentX + dropletWidth * 0.2) * 100} ${(currentY - dropletHeight * 0.35) * 100},
                               ${currentX * 100} ${(currentY - dropletHeight * 0.5) * 100} Z`;

            droplet.setAttribute("d", pathData);
            droplet.setAttribute(
              "transform",
              `rotate(${rotationDegrees} ${currentX * 100} ${currentY * 100})`,
            );
            droplet.style.opacity = (opacity * 0.78).toString();

            if (sparkle) {
              const globalTime = (now + t * 350) / 1000;
              const lightFlicker =
                0.8 +
                Math.sin(globalTime * 8) * 0.15 +
                Math.sin(globalTime * 23) * 0.05;
              const individualVariation =
                0.95 + Math.sin(i * 2.4 + globalTime * 12) * 0.05;
              const twinkle = lightFlicker * individualVariation;
              const sparkleOffsetX = -dropletWidth * 0.15;
              const sparkleOffsetY = -dropletHeight * 0.25;
              const motionAngle =
                Math.atan2(currentVelY, currentVelX) - Math.PI / 2;
              const rotatedOffsetX =
                sparkleOffsetX * Math.cos(motionAngle) -
                sparkleOffsetY * Math.sin(motionAngle);
              const rotatedOffsetY =
                sparkleOffsetX * Math.sin(motionAngle) +
                sparkleOffsetY * Math.cos(motionAngle);
              const sharedBob = Math.sin(globalTime * 6) * 0.01;
              const sparkleX = currentX + rotatedOffsetX;
              const sparkleY = currentY + rotatedOffsetY + sharedBob;

              sparkle.setAttribute("cx", (sparkleX * 100).toString());
              sparkle.setAttribute("cy", (sparkleY * 100).toString());
              sparkle.setAttribute(
                "transform",
                `rotate(${rotationDegrees} ${sparkleX * 100} ${sparkleY * 100})`,
              );
              sparkle.style.opacity = Math.max(
                0,
                opacity * twinkle * 0.75,
              ).toString();
            }
          },
        };
      },
    },
    false,
  );
}
