import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as prettier from "prettier";
import ts from "typescript";

const defaultRuntimeDirectory = fileURLToPath(
  new URL("../cloud/runtime/", import.meta.url),
);
const generatedPrefix = "// Generated from src/";

export type RuntimeGenerationResult = {
  sources: number;
  outputs: number;
  changed: string[];
  missing: string[];
  orphaned: string[];
};

function inside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

async function filesIn(
  directory: string,
  excluded: Set<string>,
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (excluded.has(entry.name) || excludedPaths.has(path)) continue;
    if (entry.isDirectory())
      files.push(...(await filesIn(path, excluded, excludedPaths)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function reportDiagnostics(diagnostics: readonly ts.Diagnostic[]): never {
  throw new Error(
    ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (path) => path,
      getNewLine: () => "\n",
    }),
  );
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function compileRuntime(runtimeDirectory: string, staging: string) {
  const sourceDirectory = join(runtimeDirectory, "src");
  const configPath = join(runtimeDirectory, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) reportDiagnostics([config.error]);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    runtimeDirectory,
  );
  if (parsed.errors.length) reportDiagnostics(parsed.errors);
  if (parsed.options.strict !== true || parsed.options.allowJs !== false)
    throw new Error(
      "Runtime compilation must enable strict and disable allowJs.",
    );
  const strictOptions = [
    "noImplicitAny",
    "noImplicitThis",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "strictBuiltinIteratorReturn",
    "alwaysStrict",
    "useUnknownInCatchVariables",
  ] as const;
  if (
    parsed.options.noCheck === true ||
    strictOptions.some((option) => parsed.options[option] === false)
  )
    throw new Error("Runtime compilation must not disable strict checks.");
  if (parsed.options.outFile)
    throw new Error("Runtime compilation must not configure outFile.");
  if (
    parsed.options.module !== ts.ModuleKind.Node16 ||
    parsed.options.moduleResolution !== ts.ModuleResolutionKind.Node16 ||
    parsed.options.target !== ts.ScriptTarget.ES2024
  )
    throw new Error("Runtime emission requires Node16 modules and ES2024.");
  if (resolve(parsed.options.rootDir || "") !== sourceDirectory)
    throw new Error("Runtime rootDir must be src.");
  if ((await realpath(sourceDirectory)) !== sourceDirectory)
    throw new Error("Runtime source directory must not be a symlink.");

  const sourceFiles = await filesIn(sourceDirectory, new Set(["node_modules"]));
  const invalidSources = sourceFiles.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      (!file.endsWith(".ts") || file.endsWith(".d.ts")),
  );
  if (invalidSources.length)
    throw new Error(
      `Runtime sources must be authored TypeScript: ${invalidSources.join(", ")}`,
    );
  const authored = sourceFiles.filter((file) => file.endsWith(".ts"));
  const configured = new Set(parsed.fileNames.map((file) => resolve(file)));
  const omitted = authored.filter((file) => !configured.has(file));
  const outside = [...configured].filter((file) => !authored.includes(file));
  if (!authored.length || omitted.length || outside.length)
    throw new Error(
      `Runtime configuration must cover every authored source. Omitted: ${omitted.join(", ")}; outside src: ${outside.join(", ")}`,
    );

  const program = ts.createProgram(authored, {
    ...parsed.options,
    noEmit: false,
    noEmitOnError: true,
    declaration: true,
    emitDeclarationOnly: false,
    declarationDir: undefined,
    outFile: undefined,
    outDir: staging,
    sourceMap: false,
    inlineSourceMap: false,
    declarationMap: false,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
  });
  const dependencyPaths = await Promise.all(
    program.getSourceFiles().map((file) => realpath(file.fileName)),
  );
  const generatedDependencies = dependencyPaths.filter(
    (file) =>
      inside(runtimeDirectory, file) &&
      !inside(sourceDirectory, file) &&
      !portable(relative(runtimeDirectory, file))
        .split("/")
        .includes("node_modules"),
  );
  if (generatedDependencies.length)
    throw new Error(
      `Runtime sources must not depend on generated artifacts: ${generatedDependencies.join(", ")}`,
    );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) reportDiagnostics(diagnostics);
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length)
    reportDiagnostics(emitted.diagnostics);

  const expectedFiles = new Set(
    authored.flatMap((source) => {
      const path = portable(relative(sourceDirectory, source));
      return [path.replace(/\.ts$/, ".js"), path.replace(/\.ts$/, ".d.ts")];
    }),
  );
  const emittedFiles = new Set(
    (await filesIn(staging, new Set())).map((file) =>
      portable(relative(staging, file)),
    ),
  );
  const unexpected = [...emittedFiles].filter(
    (file) => !expectedFiles.has(file),
  );
  const missing = [...expectedFiles].filter((file) => !emittedFiles.has(file));
  if (unexpected.length || missing.length)
    throw new Error(
      `Runtime emission does not match authored sources. Unexpected: ${unexpected.join(", ")}; missing: ${missing.join(", ")}`,
    );

  const output = new Map<string, string>();
  for (const source of authored) {
    const sourcePath = portable(relative(sourceDirectory, source));
    for (const extension of [".js", ".d.ts"]) {
      const outputPath = sourcePath.replace(/\.ts$/, extension);
      const contents = await readFile(join(staging, outputPath), "utf8");
      const banner = `${generatedPrefix}${sourcePath}. Run npm run generate:runtime.\n`;
      const destination = join(runtimeDirectory, outputPath);
      const formatting = await prettier.resolveConfig(destination, {
        useCache: false,
      });
      output.set(
        outputPath,
        await prettier.format(banner + contents, {
          ...formatting,
          filepath: destination,
        }),
      );
    }
  }
  return { authored, output };
}

async function validateArtifactPaths(
  directory: string,
  files: Iterable<string>,
): Promise<void> {
  const sourceDirectory = join(directory, "src");
  const checked = new Set<string>();
  for (const file of files) {
    const destination = resolve(directory, file);
    if (!inside(directory, destination))
      throw new Error(`Runtime artifact is outside its directory: ${file}`);
    if (inside(sourceDirectory, destination))
      throw new Error(`Runtime artifact overlaps authored source: ${file}`);
    const segments = relative(directory, destination).split(sep);
    let current = directory;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      if (checked.has(current)) continue;
      checked.add(current);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink())
          throw new Error(`Runtime artifact path contains a symlink: ${file}`);
        if (inside(sourceDirectory, await realpath(current)))
          throw new Error(`Runtime artifact overlaps authored source: ${file}`);
        const valid =
          index === segments.length - 1 ? entry.isFile() : entry.isDirectory();
        if (!valid)
          throw new Error(
            `Runtime artifact path has an incompatible entry: ${file}`,
          );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
  }
}

async function prepareOutputDirectory(
  root: string,
  directory: string,
): Promise<void> {
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current, { recursive: true });
    const actual = await realpath(current);
    if (actual !== current) await rename(actual, current);
  }
}

export async function generateRuntime({
  runtimeDirectory = defaultRuntimeDirectory,
  write = false,
}: {
  runtimeDirectory?: string;
  write?: boolean;
} = {}): Promise<RuntimeGenerationResult> {
  runtimeDirectory = await realpath(resolve(runtimeDirectory));
  const staging = await mkdtemp(join(tmpdir(), "mons-runtime-generation-"));
  try {
    const { authored, output } = await compileRuntime(
      runtimeDirectory,
      staging,
    );
    const existingFiles = await filesIn(
      runtimeDirectory,
      new Set(["node_modules", ".cache", ".wrangler", ".git"]),
      new Set([join(runtimeDirectory, "src")]),
    );
    const artifacts = existingFiles.filter((file) =>
      /\.[cm]?[jt]sx?$/.test(file),
    );
    const artifactPaths = new Set(
      artifacts.map((file) => portable(relative(runtimeDirectory, file))),
    );
    const orphaned = [...artifactPaths].filter((file) => !output.has(file));
    await validateArtifactPaths(runtimeDirectory, [
      ...output.keys(),
      ...orphaned,
    ]);
    for (const file of orphaned) {
      const contents = await readFile(join(runtimeDirectory, file), "utf8");
      if (!contents.startsWith(generatedPrefix))
        throw new Error(
          `Handwritten runtime artifact has no authored source: ${file}`,
        );
    }
    const changed: string[] = [];
    const missing: string[] = [];
    for (const [file, contents] of output) {
      const current = await readExisting(join(runtimeDirectory, file));
      if (current === null) missing.push(file);
      else if (current !== contents || !artifactPaths.has(file))
        changed.push(file);
    }
    const result = {
      sources: authored.length,
      outputs: output.size,
      changed,
      missing,
      orphaned,
    };
    if (!write && (changed.length || missing.length || orphaned.length))
      throw new Error(
        `Runtime artifacts are stale. Run npm run generate:runtime.\n${[
          ...changed.map((file) => `changed: ${file}`),
          ...missing.map((file) => `missing: ${file}`),
          ...orphaned.map((file) => `orphaned: ${file}`),
        ].join("\n")}`,
      );
    if (write) {
      for (const file of orphaned) await rm(join(runtimeDirectory, file));
      for (const file of [...changed, ...missing]) {
        const destination = join(runtimeDirectory, file);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await prepareOutputDirectory(runtimeDirectory, dirname(destination));
        try {
          await writeFile(temporary, output.get(file)!, "utf8");
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    }
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function printResult(result: RuntimeGenerationResult, write: boolean): void {
  const changes =
    result.changed.length + result.missing.length + result.orphaned.length;
  console.info(
    `Runtime: ${result.sources} checked sources, ${result.outputs} generated artifacts${write ? `, ${changes} updated` : ", current"}.`,
  );
}

async function watchRuntime(): Promise<void> {
  let pending = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = async () => {
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending) {
        pending = false;
        try {
          printResult(await generateRuntime({ write: true }), true);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 100);
  };
  const sources = watch(
    join(defaultRuntimeDirectory, "src"),
    { recursive: true },
    schedule,
  );
  const configuration = watch(defaultRuntimeDirectory, (_event, file) => {
    if (file === "tsconfig.json" || file === "package.json") schedule();
  });
  const formatterPath = await prettier.resolveConfigFile(
    join(defaultRuntimeDirectory, "package.json"),
  );
  const formatter = formatterPath
    ? watch(dirname(formatterPath), (_event, file) => {
        if (file === basename(formatterPath)) schedule();
      })
    : null;
  const stop = () => {
    sources.close();
    configuration.close();
    formatter?.close();
    clearTimeout(timer);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await rebuild();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--write", "--check", "--watch"].includes(args[0]))
    throw new Error("Usage: runtime-generation.ts --write|--check|--watch");
  if (args[0] === "--watch") return watchRuntime();
  const write = args[0] === "--write";
  printResult(await generateRuntime({ write }), write);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
