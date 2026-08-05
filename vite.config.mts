import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import checker from "vite-plugin-checker";

const defaultAppTitle = "mons.link • Play Mons";

const sharedPackageDirectory = resolve(
  import.meta.dirname,
  "cloud/functions/shared",
);
const sharedPackageManifest = JSON.parse(
  readFileSync(resolve(sharedPackageDirectory, "package.json"), "utf8"),
) as {
  name: string;
  exports: Record<string, unknown>;
};
const sharedPackageImports = Object.keys(sharedPackageManifest.exports).map(
  (subpath) => `${sharedPackageManifest.name}${subpath.slice(1)}`,
);

const restartOnSharedPackageChange = (): Plugin => ({
  name: "restart-on-shared-package-change",
  configureServer(server) {
    server.watcher.add(sharedPackageDirectory);
  },
  async hotUpdate({ file, server }) {
    const sharedRelativePath = relative(sharedPackageDirectory, file);
    if (
      sharedRelativePath === ".." ||
      sharedRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(sharedRelativePath)
    ) {
      return;
    }
    await server.restart(true);
  },
});

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, import.meta.dirname, "VITE_");
  const appTitle = environment.VITE_APP_TITLE?.trim() || defaultAppTitle;

  return {
    define: {
      "import.meta.env.VITE_APP_TITLE": JSON.stringify(appTitle),
    },
    plugins: [
      react(),
      checker({
        typescript: true,
        eslint: {
          lintCommand: 'eslint "src/**/*.{ts,tsx}"',
          watchPath: "src",
        },
        enableBuild: false,
      }),
      restartOnSharedPackageChange(),
    ],
    optimizeDeps: {
      include: sharedPackageImports,
    },
    server: {
      port: 3000,
    },
    preview: {
      port: 3000,
    },
    build: {
      outDir: "build",
    },
  };
});
