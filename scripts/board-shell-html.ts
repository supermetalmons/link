import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizePath, type Plugin, type ViteDevServer } from "vite";
import {
  renderBoardShell,
  renderBoardShellHead,
  stylesheetPath,
} from "./board-shell-renderer.ts";
import type { WatchedBoardShell } from "./render-watched-board-shell.ts";

const execute = promisify(execFile);
const watchRenderer = fileURLToPath(
  new URL("./render-watched-board-shell.ts", import.meta.url),
);

async function renderFreshShell(): Promise<WatchedBoardShell> {
  const { stdout } = await execute(process.execPath, [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    watchRenderer,
  ]);
  return JSON.parse(stdout) as WatchedBoardShell;
}

export function boardShellHtml(): Plugin {
  let watched: WatchedBoardShell | undefined;
  let devSnapshot: Promise<WatchedBoardShell> | undefined;
  const devInputs = new Set([stylesheetPath, watchRenderer].map(normalizePath));

  function getDevShell(server: ViteDevServer) {
    if (devSnapshot) return devSnapshot;
    const pending = renderFreshShell().then((shell) => {
      for (const file of shell.dependencies) devInputs.add(normalizePath(file));
      server.watcher.add(shell.dependencies);
      return shell;
    });
    devSnapshot = pending;
    void pending.catch(() => {
      if (devSnapshot === pending) devSnapshot = undefined;
    });
    return pending;
  }

  return {
    name: "board-shell-html",
    configureServer() {
      devSnapshot = undefined;
    },
    async buildStart() {
      this.addWatchFile(stylesheetPath);
      this.addWatchFile(watchRenderer);
      if (this.environment.config.command !== "build" || !this.meta.watchMode)
        return;
      watched = await renderFreshShell();
      for (const file of watched.dependencies) this.addWatchFile(file);
    },
    hotUpdate({ file }) {
      if (this.environment.name === "client" && devInputs.has(file)) {
        devSnapshot = undefined;
        this.environment.hot.send({ type: "full-reload" });
        return [];
      }
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, { server }) {
        const mount = '<div id="application"></div>';
        if (!html.includes(mount)) return html;
        const snapshot = server ? await getDevShell(server) : watched;
        const head = snapshot?.head ?? renderBoardShellHead();
        const body = snapshot?.body ?? renderBoardShell();
        return html
          .replace("</head>", () => `${head}\n</head>`)
          .replace(mount, () => body);
      },
    },
  };
}
