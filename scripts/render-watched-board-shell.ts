import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

export type WatchedBoardShell = {
  head: string;
  body: string;
  dependencies: string[];
};

const dependencies = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) dependencies.add(fileURLToPath(url));
    return nextLoad(url, context);
  },
});

const { renderBoardShell, renderBoardShellHead } =
  await import("./board-shell-renderer.ts");
const shell: WatchedBoardShell = {
  head: renderBoardShellHead(),
  body: renderBoardShell(),
  dependencies: [...dependencies],
};
process.stdout.write(JSON.stringify(shell));
