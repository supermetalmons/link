import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  colorSets,
  defaultBoardPalettes,
  getBoardAppearanceScript,
} from "../src/content/boardAppearance.ts";
import {
  BOARD_GRID_SIZE,
  getBoardPatternSquareColorKey,
} from "../src/game/boardSquareTypes.ts";
import {
  BOARD_HEIGHT_UNITS,
  BOARD_WIDTH_UNITS,
} from "../src/ui/boardOverlayGeometry.ts";

export const stylesheetPath = fileURLToPath(
  new URL("../src/board-shell.css", import.meta.url),
);

function paletteCss(mode: "light" | "dark") {
  const attribute = `data-board-palette-${mode}`;
  const fallback = defaultBoardPalettes[mode];
  const rules = Object.entries(colorSets).map(([name, palette]) => {
    const selector = `[${attribute}="${name}"]`;
    const declarations = Object.entries(palette)
      .map(([role, value]) => `--board-${role}:${value}`)
      .join(";");
    return `${name === fallback ? `:root:not([${attribute}]),` : ""}${selector}{${declarations}}`;
  });
  return `@media (prefers-color-scheme:${mode}){${rules.join("\n")}}`;
}

export function renderBoardShellHead(): string {
  const css = readFileSync(stylesheetPath, "utf8");
  return `<style>${css}\n${paletteCss("light")}\n${paletteCss("dark")}</style>
<script>${getBoardAppearanceScript()}</script>`;
}

export function renderBoardShell(): string {
  const cells: string[] = [];
  for (let row = 0; row < BOARD_GRID_SIZE; row++) {
    for (let col = 0; col < BOARD_GRID_SIZE; col++) {
      const role = getBoardPatternSquareColorKey(row, col, null, true);
      cells.push(
        `<rect x="${col * 100}" y="${(row + 1) * 100}" width="100" height="100" fill="var(--board-${role})"/>`,
      );
    }
  }
  return `<div id="application"><div id="board-aura-host"></div>
<svg id="board-backdrop" class="board-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_WIDTH_UNITS * 100} ${BOARD_HEIGHT_UNITS * 100}" shape-rendering="crispEdges" overflow="visible" aria-hidden="true">
<g id="boardBackgroundLayer"><g id="board-grid">${cells.join("")}</g>
<g id="board-picture"><rect x="1" y="101" width="1098" height="1161"/></g></g></svg>
<div id="root"></div></div>`;
}
