import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_D1_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "migrations"),
          ),
        },
      },
    }),
  ],
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@spruceid/siwe-parser"],
        },
      },
    },
    include: ["runtime/**/*.test.ts"],
  },
}));
