export type Point = { x: number; y: number };
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type SplitEllipse = {
  cx: number;
  cy: number;
  rx: number;
  ryTop: number;
  ryBottom: number;
};
export type IslandHotspot = { cxPct: number; cyPct: number; dPct: number };

export const THEORETICAL_ROCK_SQUARE = {
  cx: 0.5018,
  cy: 0.1773,
  side: 0.142,
};
export const THEORETICAL_ROCK_BOTTOM = Math.max(
  0,
  Math.min(1, THEORETICAL_ROCK_SQUARE.cy + THEORETICAL_ROCK_SQUARE.side * 0.5),
);

export const ISLAND_HOTSPOTS: IslandHotspot[] = [
  {
    cxPct: 0.2267901200343747,
    cyPct: 0.4402455174645712,
    dPct: 0.0852713178294574,
  },
  {
    cxPct: 0.1408001429826479,
    cyPct: 0.4011414993640988,
    dPct: 0.0867806613609959,
  },
  {
    cxPct: 0.2303384803038283,
    cyPct: 0.5319767441860465,
    dPct: 0.0929130855394721,
  },
  {
    cxPct: 0.1434036537022149,
    cyPct: 0.486757145371548,
    dPct: 0.0845797097419015,
  },
  {
    cxPct: 0.2285643001691015,
    cyPct: 0.623062015503876,
    dPct: 0.0883856918681502,
  },
  {
    cxPct: 0.3438860089263438,
    cyPct: 0.6941214864568193,
    dPct: 0.1009076145131653,
  },
  {
    cxPct: 0.3845540733282993,
    cyPct: 0.81524926686217,
    dPct: 0.1389820732761389,
  },
  {
    cxPct: 0.2498544617858232,
    cyPct: 0.7180232558139535,
    dPct: 0.0950205478459788,
  },
  {
    cxPct: 0.3228039265039013,
    cyPct: 0.4941348973607038,
    dPct: 0.0965006757489889,
  },
  {
    cxPct: 0.1482926420001678,
    cyPct: 0.5733137829912024,
    dPct: 0.0805273150244885,
  },
  {
    cxPct: 0.3254887154962665,
    cyPct: 0.5967741935483871,
    dPct: 0.1046383272819784,
  },
];

export const HOTSPOT_LABELS = [2, 1, 5, 4, 8, 9, 11, 10, 3, 7, 6];

export const DISMISS_ALLOWED_TRIANGLE_A: Point[] = [
  { x: 0, y: 0.7287 },
  { x: 0.2087, y: 1 },
  { x: 0, y: 1 },
];

export const DISMISS_ALLOWED_TRIANGLE_B: Point[] = [
  { x: 1, y: 0.5753 },
  { x: 1, y: 1 },
  { x: 0.6977, y: 1 },
];

export const NO_WALK_TETRAGON: Point[] = [
  { x: 0.0745, y: 0.2636 },
  { x: 0.4116, y: 0.4467 },
  { x: 0.4079, y: 0.6358 },
  { x: 0.0579, y: 0.5272 },
];

export const STAR_SHINE_PENTAGON: Point[] = [
  { x: 0.465, y: 0.9558 },
  { x: 0.6805, y: 0.4044 },
  { x: 0.9532, y: 0.2415 },
  { x: 0.8997, y: 0.497 },
  { x: 0.6474, y: 0.9014 },
];

export const STAR_SHINE_PENTAGON_BOUNDS = getPolygonBounds(STAR_SHINE_PENTAGON);

export const SMALLER_SMOOTH_CYCLING_ELLIPSE: SplitEllipse = {
  cx: 0.4982,
  cy: 0.1928,
  rx: 0.3495,
  ryTop: 0.1143,
  ryBottom: 0.1492,
};

export const SMOOTH_CYCLING_ELLIPSE: SplitEllipse = {
  cx: 0.4982,
  cy: 0.1928,
  rx: 0.36,
  ryTop: 0.1143,
  ryBottom: 0.175,
};

const SAFE_POINT_EDGE_INSET = 0.003;
const SAFE_POINT_AREA_ELLIPSE_CENTER_OFFSET_X = 0;
const SAFE_POINT_AREA_ELLIPSE_CENTER_OFFSET_Y = 0.042;
const SAFE_POINT_AREA_ELLIPSE_RADIUS_FRAC_X = 0.63;
const SAFE_POINT_AREA_ELLIPSE_RADIUS_FRAC_Y = 0.36;

const smoothEllipseMetrics = createSplitEllipseMetrics(SMOOTH_CYCLING_ELLIPSE);
const holeCentroid = getPolygonCentroid(NO_WALK_TETRAGON);

export function getPolygonBounds(points: Point[]) {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, maxX, minY, maxY };
}

export function pointInTriangle(px: number, py: number, triangle: Point[]) {
  const a = triangle[0];
  const b = triangle[1];
  const c = triangle[2];
  const s1 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const s2 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const s3 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

export function pointInPolygon(x: number, y: number, polygon: Point[]) {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersect =
      currentPoint.y > y !== previousPoint.y > y &&
      x <
        ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function getPolygonCentroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0.5, y: 0.5 };
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    x += polygon[index].x;
    y += polygon[index].y;
  }
  return { x: x / polygon.length, y: y / polygon.length };
}

function createSplitEllipseMetrics(ellipse: SplitEllipse) {
  const rx = Math.max(1e-6, ellipse.rx);
  const ryTop = Math.max(1e-6, ellipse.ryTop);
  const ryBottom = Math.max(1e-6, ellipse.ryBottom);
  const ryMid = Math.max(1e-6, (ryTop + ryBottom) * 0.5);
  return {
    invRxSq: 1 / (rx * rx),
    invRyTopSq: 1 / (ryTop * ryTop),
    invRyBottomSq: 1 / (ryBottom * ryBottom),
    invRyMidSq: 1 / (ryMid * ryMid),
  };
}

function pickInvRySq(dy: number) {
  if (dy > 1e-6) return smoothEllipseMetrics.invRyBottomSq;
  if (dy < -1e-6) return smoothEllipseMetrics.invRyTopSq;
  return smoothEllipseMetrics.invRyMidSq;
}

export function isInsideSmoothEllipse(x: number, y: number) {
  const dx = x - SMOOTH_CYCLING_ELLIPSE.cx;
  const dy = y - SMOOTH_CYCLING_ELLIPSE.cy;
  const invRySq = pickInvRySq(dy);
  if (smoothEllipseMetrics.invRxSq === 0 || invRySq === 0) return false;
  return dx * dx * smoothEllipseMetrics.invRxSq + dy * dy * invRySq <= 1;
}

export function projectToSmoothEllipse(x: number, y: number): Point {
  const dx = x - SMOOTH_CYCLING_ELLIPSE.cx;
  const dy = y - SMOOTH_CYCLING_ELLIPSE.cy;
  const invRySq = pickInvRySq(dy);
  if (smoothEllipseMetrics.invRxSq === 0 || invRySq === 0) {
    return {
      x: Math.max(0, Math.min(1, SMOOTH_CYCLING_ELLIPSE.cx)),
      y: Math.max(0, Math.min(1, SMOOTH_CYCLING_ELLIPSE.cy)),
    };
  }
  const denominator =
    Math.sqrt(dx * dx * smoothEllipseMetrics.invRxSq + dy * dy * invRySq) || 1;
  const projectedX = SMOOTH_CYCLING_ELLIPSE.cx + dx / denominator;
  const projectedY = SMOOTH_CYCLING_ELLIPSE.cy + dy / denominator;
  const vectorX = projectedX - SMOOTH_CYCLING_ELLIPSE.cx;
  const vectorY = projectedY - SMOOTH_CYCLING_ELLIPSE.cy;
  const vectorLength = Math.hypot(vectorX, vectorY) || 1;
  return {
    x: Math.max(
      0,
      Math.min(
        1,
        projectedX - (vectorX / vectorLength) * SAFE_POINT_EDGE_INSET,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1,
        projectedY - (vectorY / vectorLength) * SAFE_POINT_EDGE_INSET,
      ),
    ),
  };
}

export function isInsideHole(x: number, y: number) {
  return pointInPolygon(x, y, NO_WALK_TETRAGON);
}

export function projectOutsideHole(point: Point): Point | null {
  if (NO_WALK_TETRAGON.length === 0) return null;
  let best: (Point & { d2: number }) | null = null;
  for (let index = 0; index < NO_WALK_TETRAGON.length; index += 1) {
    const a = NO_WALK_TETRAGON[index];
    const b = NO_WALK_TETRAGON[(index + 1) % NO_WALK_TETRAGON.length];
    const vectorX = b.x - a.x;
    const vectorY = b.y - a.y;
    const lengthSquared = vectorX * vectorX + vectorY * vectorY || 1;
    let ratio =
      ((point.x - a.x) * vectorX + (point.y - a.y) * vectorY) / lengthSquared;
    if (ratio < 0) ratio = 0;
    else if (ratio > 1) ratio = 1;
    const candidateX = a.x + vectorX * ratio;
    const candidateY = a.y + vectorY * ratio;
    const dx = point.x - candidateX;
    const dy = point.y - candidateY;
    const distanceSquared = dx * dx + dy * dy;
    if (!best || distanceSquared < best.d2) {
      best = { x: candidateX, y: candidateY, d2: distanceSquared };
    }
  }
  if (!best) return null;
  const directionX = best.x - holeCentroid.x;
  const directionY = best.y - holeCentroid.y;
  const length = Math.hypot(directionX, directionY) || 1;
  const candidate = {
    x: Math.max(
      0,
      Math.min(1, best.x + (directionX / length) * SAFE_POINT_EDGE_INSET),
    ),
    y: Math.max(
      0,
      Math.min(1, best.y + (directionY / length) * SAFE_POINT_EDGE_INSET),
    ),
  };
  if (pointInPolygon(candidate.x, candidate.y, NO_WALK_TETRAGON)) {
    const fallback = {
      x: Math.max(
        0,
        Math.min(1, best.x + (directionX / length) * SAFE_POINT_EDGE_INSET * 4),
      ),
      y: Math.max(
        0,
        Math.min(1, best.y + (directionY / length) * SAFE_POINT_EDGE_INSET * 4),
      ),
    };
    if (
      !pointInPolygon(fallback.x, fallback.y, NO_WALK_TETRAGON) &&
      isInsideSmoothEllipse(fallback.x, fallback.y)
    ) {
      return fallback;
    }
    return null;
  }
  return isInsideSmoothEllipse(candidate.x, candidate.y) ? candidate : null;
}

export function isInsideWalkArea(x: number, y: number) {
  return isInsideSmoothEllipse(x, y) && !isInsideHole(x, y);
}

export function clampWalkTarget(from: Point, desired: Point): Point {
  if (isInsideWalkArea(desired.x, desired.y)) return { ...desired };
  const insideEllipse = isInsideSmoothEllipse(desired.x, desired.y);
  if (isInsideHole(desired.x, desired.y)) {
    const projected = projectOutsideHole(desired);
    if (projected && !isInsideHole(projected.x, projected.y)) return projected;
    const ellipseFallback = projectToSmoothEllipse(desired.x, desired.y);
    if (!isInsideHole(ellipseFallback.x, ellipseFallback.y)) {
      return ellipseFallback;
    }
    return { ...from };
  }
  if (!insideEllipse) {
    const edge = projectToSmoothEllipse(desired.x, desired.y);
    if (!isInsideHole(edge.x, edge.y)) return edge;
  }
  if (insideEllipse) {
    const outsideHole = projectOutsideHole(desired);
    if (
      outsideHole &&
      isInsideSmoothEllipse(outsideHole.x, outsideHole.y) &&
      !isInsideHole(outsideHole.x, outsideHole.y)
    ) {
      return outsideHole;
    }
  }
  const fallback = projectToSmoothEllipse(desired.x, desired.y);
  return !isInsideHole(fallback.x, fallback.y) ? fallback : { ...from };
}

export function createSafeAreaEllipse(box: Bounds | null) {
  if (!box) return null;
  return {
    cx: (box.left + box.right) * 0.5 + SAFE_POINT_AREA_ELLIPSE_CENTER_OFFSET_X,
    cy: (box.top + box.bottom) * 0.5 + SAFE_POINT_AREA_ELLIPSE_CENTER_OFFSET_Y,
    rx: SAFE_POINT_AREA_ELLIPSE_RADIUS_FRAC_X,
    ry: SAFE_POINT_AREA_ELLIPSE_RADIUS_FRAC_Y,
  };
}

export function isInsideEllipse(
  x: number,
  y: number,
  ellipse: { cx: number; cy: number; rx: number; ry: number } | null,
) {
  if (!ellipse) return false;
  const dx = (x - ellipse.cx) / ellipse.rx;
  const dy = (y - ellipse.cy) / ellipse.ry;
  return dx * dx + dy * dy <= 1;
}

export function computeOverlapArea(a: Bounds, b: Bounds) {
  const width = Math.max(
    0,
    Math.min(a.right, b.right) - Math.max(a.left, b.left),
  );
  const height = Math.max(
    0,
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  );
  return width * height;
}
