import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateRuntime } from "./runtime-generation.ts";

async function fixture(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "mons-runtime-generation-test-"),
  );
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "package.json"), '{"type":"commonjs"}\n');
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: false,
          noEmit: true,
          target: "ES2024",
          module: "Node16",
          moduleResolution: "Node16",
          rootDir: "src",
          types: [],
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(directory, "src/value.ts"),
      "export const value: number = 1;\n",
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("runtime generation emits checked CommonJS and declarations deterministically", async () => {
  await fixture(async (runtimeDirectory) => {
    const first = await generateRuntime({ runtimeDirectory, write: true });
    assert.equal(first.sources, 1);
    assert.equal(first.outputs, 2);
    assert.deepEqual(first.missing.sort(), ["value.d.ts", "value.js"]);
    const js = await readFile(join(runtimeDirectory, "value.js"), "utf8");
    const declaration = await readFile(
      join(runtimeDirectory, "value.d.ts"),
      "utf8",
    );
    assert.match(js, /^\/\/ Generated from src\/value\.ts\./);
    assert.match(js, /exports\.value = 1/);
    assert.match(declaration, /export declare const value: number/);
    const second = await generateRuntime({ runtimeDirectory, write: true });
    assert.deepEqual(second.changed, []);
    assert.deepEqual(second.missing, []);
    assert.deepEqual(second.orphaned, []);
    await generateRuntime({ runtimeDirectory });
    assert.equal(
      await readFile(join(runtimeDirectory, "value.js"), "utf8"),
      js,
    );
  });
});

test("runtime generation preserves outputs through case-only source renames", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    await rename(
      join(runtimeDirectory, "src/value.ts"),
      join(runtimeDirectory, "src/Value.ts"),
    );
    await generateRuntime({ runtimeDirectory, write: true });
    const files = await readdir(runtimeDirectory);
    assert.ok(files.includes("Value.js"));
    assert.ok(files.includes("Value.d.ts"));
    assert.ok(!files.includes("value.js"));
    assert.ok(!files.includes("value.d.ts"));
    assert.match(
      await readFile(join(runtimeDirectory, "Value.js"), "utf8"),
      /exports\.value = 1/,
    );
    await generateRuntime({ runtimeDirectory });
  });
});

test("runtime generation repairs output casing even when contents already match", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    await rename(
      join(runtimeDirectory, "value.js"),
      join(runtimeDirectory, "Value.js"),
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory }),
      /Runtime artifacts are stale/,
    );
    await generateRuntime({ runtimeDirectory, write: true });
    const files = await readdir(runtimeDirectory);
    assert.ok(files.includes("value.js"));
    assert.ok(!files.includes("Value.js"));
    await generateRuntime({ runtimeDirectory });
  });
});

test("runtime generation handles case-only parent directory renames", async () => {
  await fixture(async (runtimeDirectory) => {
    await mkdir(join(runtimeDirectory, "src/nested"));
    await writeFile(
      join(runtimeDirectory, "src/nested/helper.ts"),
      "export const helper = 42;\n",
    );
    await generateRuntime({ runtimeDirectory, write: true });
    const unchanged = await readFile(
      join(runtimeDirectory, "value.js"),
      "utf8",
    );
    await rename(
      join(runtimeDirectory, "src/nested"),
      join(runtimeDirectory, "src/Nested"),
    );
    await generateRuntime({ runtimeDirectory, write: true });
    assert.ok((await readdir(runtimeDirectory)).includes("Nested"));
    assert.match(
      await readFile(join(runtimeDirectory, "Nested/helper.js"), "utf8"),
      /exports\.helper = 42/,
    );
    assert.equal(
      await readFile(join(runtimeDirectory, "value.js"), "utf8"),
      unchanged,
    );
    await generateRuntime({ runtimeDirectory });
  });
});

test("runtime checking detects missing, edited, and orphaned output without repairing it", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    const file = join(runtimeDirectory, "value.js");
    await writeFile(file, "module.exports = {value: 99};\n");
    await rm(join(runtimeDirectory, "value.d.ts"));
    const orphan = join(runtimeDirectory, "retired.js");
    await writeFile(
      orphan,
      "// Generated from src/retired.ts.\nexports.retired = true;\n",
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory }),
      (error: Error) => {
        assert.match(error.message, /changed: value\.js/);
        assert.match(error.message, /missing: value\.d\.ts/);
        assert.match(error.message, /orphaned: retired\.js/);
        return true;
      },
    );
    assert.equal(
      await readFile(file, "utf8"),
      "module.exports = {value: 99};\n",
    );
    assert.match(await readFile(orphan, "utf8"), /retired/);
    await generateRuntime({ runtimeDirectory, write: true });
    await assert.rejects(readFile(orphan), { code: "ENOENT" });
    await generateRuntime({ runtimeDirectory });
  });
});

test("runtime compilation errors leave every existing artifact untouched", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    const file = join(runtimeDirectory, "value.js");
    const before = await readFile(file, "utf8");
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'export const value: number = "invalid";\n',
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /not assignable/,
    );
    assert.equal(await readFile(file, "utf8"), before);
    const declaration = await readFile(
      join(runtimeDirectory, "value.d.ts"),
      "utf8",
    );
    assert.match(declaration, /value: number/);
  });
});

test("runtime coverage rejects omitted sources and authored JavaScript", async () => {
  await fixture(async (runtimeDirectory) => {
    const configPath = join(runtimeDirectory, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.include = ["src/value.ts"];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(runtimeDirectory, "src/omitted.ts"),
      "export const omitted = 1;\n",
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /cover every authored source/,
    );
    await rm(join(runtimeDirectory, "src/omitted.ts"));
    await writeFile(
      join(runtimeDirectory, "src/unchecked.js"),
      "exports.value = 1;\n",
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /authored TypeScript/,
    );
  });
});

test("runtime sources cannot typecheck against an old generated declaration", async () => {
  await fixture(async (runtimeDirectory) => {
    await writeFile(
      join(runtimeDirectory, "legacy.d.ts"),
      "export const legacy: number;\n",
    );
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'export { legacy } from "../legacy.js";\n',
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /must not depend on generated artifacts/,
    );
  });
});

test("runtime generation refuses to delete handwritten orphaned modules", async () => {
  await fixture(async (runtimeDirectory) => {
    const orphan = join(runtimeDirectory, "handwritten.js");
    const contents = "exports.keep = true;\n";
    await writeFile(orphan, contents);
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /Handwritten runtime artifact/,
    );
    assert.equal(await readFile(orphan, "utf8"), contents);
    await assert.rejects(readFile(join(runtimeDirectory, "value.js")), {
      code: "ENOENT",
    });
  });
});

test("runtime generation preserves native dynamic imports and type-only modules", async () => {
  await fixture(async (runtimeDirectory) => {
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'export const load = () => import("./contract.js");\n',
    );
    await writeFile(
      join(runtimeDirectory, "src/contract.ts"),
      "export type Contract = { id: string };\n",
    );
    await generateRuntime({ runtimeDirectory, write: true });
    const contents = await readFile(join(runtimeDirectory, "value.js"), "utf8");
    assert.match(contents, /import\("\.\/contract\.js"\)/);
    assert.doesNotMatch(contents, /require\("\.\/contract\.js"\)/);
    assert.match(
      await readFile(join(runtimeDirectory, "contract.d.ts"), "utf8"),
      /type Contract/,
    );
  });
});

test("runtime generation rejects unaccounted JSON emission without changing outputs", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    const jsPath = join(runtimeDirectory, "value.js");
    const declarationPath = join(runtimeDirectory, "value.d.ts");
    const before = await readFile(jsPath, "utf8");
    const declarationBefore = await readFile(declarationPath, "utf8");
    const configPath = join(runtimeDirectory, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.compilerOptions.resolveJsonModule = true;
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(runtimeDirectory, "src/data.json"), '{"value":42}\n');
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'import data from "./data.json"; export const value = data.value;\n',
    );
    for (const write of [false, true]) {
      await assert.rejects(
        generateRuntime({ runtimeDirectory, write }),
        /Runtime emission does not match authored sources.*data\.json/,
      );
      assert.equal(await readFile(jsPath, "utf8"), before);
      assert.equal(await readFile(declarationPath, "utf8"), declarationBefore);
    }
  });
});

test("runtime generation rejects unaccounted transitive TypeScript emission", async () => {
  await fixture(async (runtimeDirectory) => {
    const dependency = await mkdtemp(
      join(tmpdir(), "mons-runtime-dependency-"),
    );
    try {
      await generateRuntime({ runtimeDirectory, write: true });
      const outputPath = join(runtimeDirectory, "value.js");
      const before = await readFile(outputPath, "utf8");
      const declarationPath = join(runtimeDirectory, "value.d.ts");
      const declarationBefore = await readFile(declarationPath, "utf8");
      const configPath = join(runtimeDirectory, "tsconfig.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.include = ["src/value.ts"];
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(
        join(dependency, "helper.ts"),
        "export const value = 42;\n",
      );
      await symlink(dependency, join(runtimeDirectory, "src/linked"), "dir");
      await writeFile(
        join(runtimeDirectory, "src/value.ts"),
        'export { value } from "./linked/helper.js";\n',
      );
      for (const write of [false, true]) {
        await assert.rejects(
          generateRuntime({ runtimeDirectory, write }),
          /Runtime emission does not match authored sources.*linked\/helper/,
        );
        assert.equal(await readFile(outputPath, "utf8"), before);
        assert.equal(
          await readFile(declarationPath, "utf8"),
          declarationBefore,
        );
      }
    } finally {
      await rm(dependency, { recursive: true, force: true });
    }
  });
});

test("runtime generation rejects disabled strict checks and redirected emission", async () => {
  await fixture(async (runtimeDirectory) => {
    const configPath = join(runtimeDirectory, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const overrides of [
      { noCheck: true },
      { noImplicitAny: false },
      { strictNullChecks: false },
      { outFile: join(runtimeDirectory, "escaped.js") },
      { module: "CommonJS", moduleResolution: "Node10" },
    ]) {
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          compilerOptions: { ...config.compilerOptions, ...overrides },
        }),
      );
      await assert.rejects(
        generateRuntime({ runtimeDirectory, write: true }),
        /disable strict checks|configure outFile|requires Node16/,
      );
      await assert.rejects(readFile(join(runtimeDirectory, "value.js")), {
        code: "ENOENT",
      });
      await assert.rejects(readFile(join(runtimeDirectory, "escaped.js")), {
        code: "ENOENT",
      });
    }
  });
});

test("runtime coverage follows package symlinks to reject stale declarations", async () => {
  await fixture(async (runtimeDirectory) => {
    const configPath = join(runtimeDirectory, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.compilerOptions.preserveSymlinks = true;
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(join(runtimeDirectory, "src/shared"));
    await mkdir(join(runtimeDirectory, "shared"));
    await mkdir(join(runtimeDirectory, "node_modules/@mons"), {
      recursive: true,
    });
    await writeFile(
      join(runtimeDirectory, "shared/package.json"),
      JSON.stringify({
        name: "@mons/shared",
        type: "commonjs",
        exports: { "./value": "./value.js" },
      }),
    );
    await writeFile(
      join(runtimeDirectory, "shared/value.d.ts"),
      "export const value: number;\n",
    );
    await writeFile(
      join(runtimeDirectory, "src/shared/value.ts"),
      'export const value = "actual string";\n',
    );
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'import {value as stale} from "@mons/shared/value"; export const value: number = stale;\n',
    );
    await symlink(
      join(runtimeDirectory, "shared"),
      join(runtimeDirectory, "node_modules/@mons/shared"),
      "dir",
    );
    await assert.rejects(
      generateRuntime({ runtimeDirectory, write: true }),
      /must not depend on generated artifacts/,
    );
    await assert.rejects(readFile(join(runtimeDirectory, "value.js")), {
      code: "ENOENT",
    });
  });
});

test("runtime generation preflights symlinked files and directories before writing", async () => {
  for (const kind of ["file", "directory"]) {
    await fixture(async (runtimeDirectory) => {
      const outside = await mkdtemp(join(tmpdir(), "mons-runtime-outside-"));
      try {
        const retained = join(outside, "retained.js");
        await writeFile(retained, "outside contents\n");
        if (kind === "file") {
          await symlink(retained, join(runtimeDirectory, "value.js"));
        } else {
          await mkdir(join(runtimeDirectory, "src/nested"));
          await writeFile(
            join(runtimeDirectory, "src/nested/retained.ts"),
            "export const retained = true;\n",
          );
          await symlink(outside, join(runtimeDirectory, "nested"), "dir");
        }
        await assert.rejects(
          generateRuntime({ runtimeDirectory, write: true }),
          /path contains a symlink/,
        );
        assert.equal(await readFile(retained, "utf8"), "outside contents\n");
        await assert.rejects(readFile(join(runtimeDirectory, "value.d.ts")), {
          code: "ENOENT",
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("runtime generation observes updated formatting configuration within one process", async () => {
  await fixture(async (runtimeDirectory) => {
    const configPath = join(runtimeDirectory, ".prettierrc.json");
    await writeFile(configPath, JSON.stringify({ singleQuote: false }));
    await writeFile(
      join(runtimeDirectory, "src/value.ts"),
      'export const value = "text";\n',
    );
    await generateRuntime({ runtimeDirectory, write: true });
    assert.match(
      await readFile(join(runtimeDirectory, "value.js"), "utf8"),
      /"text"/,
    );
    await writeFile(configPath, JSON.stringify({ singleQuote: true }));
    await generateRuntime({ runtimeDirectory, write: true });
    assert.match(
      await readFile(join(runtimeDirectory, "value.js"), "utf8"),
      /'text'/,
    );
    await generateRuntime({ runtimeDirectory });
  });
});

test("runtime source-overlapping outputs fail before any artifact mutation", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    const preservedPaths = ["value.js", "value.d.ts", "retired.js"];
    await writeFile(
      join(runtimeDirectory, "retired.js"),
      "// Generated from src/retired.ts.\nexports.retired = true;\n",
    );
    const before = await Promise.all(
      preservedPaths.map((file) =>
        readFile(join(runtimeDirectory, file), "utf8"),
      ),
    );
    const source = "export const helper = 42;\n";
    await mkdir(join(runtimeDirectory, "src/src"));
    await writeFile(join(runtimeDirectory, "src/src/helper.ts"), source);

    for (const write of [false, true]) {
      await assert.rejects(
        generateRuntime({ runtimeDirectory, write }),
        /source.*(?:overlap|artifact)|artifact.*(?:source|author)/i,
      );
      assert.deepEqual(
        await Promise.all(
          preservedPaths.map((file) =>
            readFile(join(runtimeDirectory, file), "utf8"),
          ),
        ),
        before,
      );
      assert.equal(
        await readFile(join(runtimeDirectory, "src/src/helper.ts"), "utf8"),
        source,
      );
      assert.equal(
        await readFile(join(runtimeDirectory, "src/value.ts"), "utf8"),
        "export const value: number = 1;\n",
      );
      for (const extension of ["js", "d.ts"]) {
        await assert.rejects(
          readFile(join(runtimeDirectory, `src/helper.${extension}`)),
          { code: "ENOENT" },
        );
      }
    }
  });
});

test("runtime output overlap checks respect filesystem case aliases", async () => {
  await fixture(async (runtimeDirectory) => {
    await generateRuntime({ runtimeDirectory, write: true });
    const authorDirectory = await realpath(join(runtimeDirectory, "src"));
    let aliasesAuthorDirectory = false;
    try {
      aliasesAuthorDirectory =
        (await realpath(join(runtimeDirectory, "Src"))) === authorDirectory;
    } catch (error) {
      assert.ok(
        error instanceof Error && "code" in error && error.code === "ENOENT",
      );
    }
    const preservedPaths = ["value.js", "value.d.ts", "retired.js"];
    await writeFile(
      join(runtimeDirectory, "retired.js"),
      "// Generated from src/retired.ts.\nexports.retired = true;\n",
    );
    const before = await Promise.all(
      preservedPaths.map((file) =>
        readFile(join(runtimeDirectory, file), "utf8"),
      ),
    );
    const source = "export const helper = 42;\n";
    await mkdir(join(runtimeDirectory, "src/Src"));
    await writeFile(join(runtimeDirectory, "src/Src/helper.ts"), source);

    if (!aliasesAuthorDirectory) {
      await generateRuntime({ runtimeDirectory, write: true });
      const directories = await readdir(runtimeDirectory);
      assert.ok(directories.includes("src"));
      assert.ok(directories.includes("Src"));
      assert.match(
        await readFile(join(runtimeDirectory, "Src/helper.js"), "utf8"),
        /exports\.helper = 42/,
      );
      assert.equal(
        await readFile(join(runtimeDirectory, "src/Src/helper.ts"), "utf8"),
        source,
      );
      await generateRuntime({ runtimeDirectory });
      return;
    }

    for (const write of [false, true]) {
      await assert.rejects(
        generateRuntime({ runtimeDirectory, write }),
        /source.*(?:overlap|artifact)|artifact.*(?:source|author)/i,
      );
      assert.deepEqual(
        await Promise.all(
          preservedPaths.map((file) =>
            readFile(join(runtimeDirectory, file), "utf8"),
          ),
        ),
        before,
      );
      const directories = await readdir(runtimeDirectory);
      assert.ok(directories.includes("src"));
      assert.ok(!directories.includes("Src"));
      assert.equal(
        await realpath(join(runtimeDirectory, "src")),
        authorDirectory,
      );
      assert.equal(
        await readFile(join(runtimeDirectory, "src/Src/helper.ts"), "utf8"),
        source,
      );
      for (const extension of ["js", "d.ts"]) {
        await assert.rejects(
          readFile(join(runtimeDirectory, `src/helper.${extension}`)),
          { code: "ENOENT" },
        );
      }
    }
  });
});

test("nested source-named output directories are checked and cleaned normally", async () => {
  await fixture(async (runtimeDirectory) => {
    await mkdir(join(runtimeDirectory, "src/domain/src"), { recursive: true });
    await writeFile(
      join(runtimeDirectory, "src/domain/src/helper.ts"),
      "export const helper = 42;\n",
    );
    const first = await generateRuntime({ runtimeDirectory, write: true });
    assert.equal(first.sources, 2);
    assert.equal(first.outputs, 4);
    assert.match(
      await readFile(join(runtimeDirectory, "domain/src/helper.js"), "utf8"),
      /exports\.helper = 42/,
    );
    await generateRuntime({ runtimeDirectory });
    const unchanged = await generateRuntime({ runtimeDirectory, write: true });
    assert.deepEqual(unchanged.changed, []);
    assert.deepEqual(unchanged.missing, []);
    assert.deepEqual(unchanged.orphaned, []);

    await rm(join(runtimeDirectory, "src/domain/src/helper.ts"));
    await assert.rejects(
      generateRuntime({ runtimeDirectory }),
      /orphaned: domain\/src\/helper\.js/,
    );
    const cleaned = await generateRuntime({ runtimeDirectory, write: true });
    assert.deepEqual(cleaned.orphaned.sort(), [
      "domain/src/helper.d.ts",
      "domain/src/helper.js",
    ]);
    for (const file of cleaned.orphaned) {
      await assert.rejects(readFile(join(runtimeDirectory, file)), {
        code: "ENOENT",
      });
    }
    await generateRuntime({ runtimeDirectory });
  });
});
