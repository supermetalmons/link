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
          TEST_AUTH_STATE_D1_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "auth-state-migrations"),
          ),
          TEST_D1_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "migrations"),
          ),
          TEST_TELEGRAM_D1_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "telegram-migrations"),
          ),
        },
      },
    }),
  ],
  test: {
    server: {
      deps: {
        inline: [
          "@metaplex-foundation/umi-bundle-defaults",
          "@metaplex-foundation/umi-eddsa-web3js",
          "@solana/web3.js",
          /@metaplex-foundation\/.*/,
          /@noble\/.*/,
          /@solana\/.*/,
        ],
      },
    },
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            "@metaplex-foundation/mpl-bubblegum",
            "@metaplex-foundation/mpl-core",
            "@metaplex-foundation/umi",
            "@metaplex-foundation/umi-bundle-defaults",
            "@metaplex-foundation/umi-eddsa-web3js",
            "@solana/web3.js",
            "@spruceid/siwe-parser",
          ],
        },
      },
    },
    include: ["runtime/**/*.test.ts"],
  },
}));
