import { createServer, loadConfigFromFile, mergeConfig } from "vite";

/** @param {import("vite").InlineConfig} options */
export async function createBrowserViteServer(options) {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    undefined,
    options.root,
    "error",
  );
  if (!loaded) throw new Error("browser-test-vite-config-missing");
  /** @type {import("vite").InlineConfig} */
  const config = mergeConfig(loaded.config, options);
  if (!config.plugins) throw new Error("browser-test-vite-plugins-missing");
  return createServer({
    ...config,
    configFile: false,
    plugins: config.plugins.filter(
      (plugin) =>
        !(
          plugin &&
          typeof plugin === "object" &&
          "name" in plugin &&
          plugin.name === "vite-plugin-checker"
        ),
    ),
  });
}

/** @param {import("vite").ViteDevServer} server */
export function browserServerOrigin(server) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string")
    throw new Error("browser-test-server-address-missing");
  return `http://127.0.0.1:${address.port}`;
}
