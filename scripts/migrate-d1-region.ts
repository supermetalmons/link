import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeMigration } from "./d1-migration/operator.ts";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  executeMigration().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "D1 migration failed; inspect saved status",
    );
    process.exitCode = 1;
  });
}
