import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSION = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;
const STRICT_FLAGS = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "alwaysStrict",
  "useUnknownInCatchVariables",
] as const;

function scriptsAt(root: string): Record<string, string> {
  const value: unknown = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("scripts" in value) ||
    !value.scripts ||
    typeof value.scripts !== "object" ||
    Array.isArray(value.scripts)
  )
    throw new Error("typecheck-package-scripts-invalid");
  const result: Record<string, string> = {};
  for (const [key, command] of Object.entries(value.scripts)) {
    if (typeof command !== "string")
      throw new Error("typecheck-package-script-invalid");
    result[key] = command;
  }
  return result;
}

export function checkedProjects(root = ROOT): string[] {
  const scripts = scriptsAt(root),
    seen = new Set<string>(),
    projects = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const script = scripts[name];
    if (!script) throw new Error(`typecheck-script-missing:${name}`);
    for (const command of script.split(/\s*&&\s*/)) {
      const nested = /^npm run ([\w:.-]+)(?:\s|$)/.exec(command);
      if (nested?.[1]) visit(nested[1]);
      if (!/^(?:npx )?tsc(?:\s|$)/.test(command)) continue;
      const project =
        /(?:^|\s)(?:-p|--project)(?:=|\s+)([^\s]+)/.exec(command)?.[1] ??
        "tsconfig.json";
      const path = resolve(root, project),
        local = relative(root, path);
      if (isAbsolute(local) || local === ".." || local.startsWith("../"))
        throw new Error("typecheck-project-outside-repository");
      projects.add(path);
    }
  };
  visit("check:all");
  return [...projects].sort();
}

export function maintainedTestAndConfigFiles(root = ROOT): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".cache", ".vite", "test-results"].includes(item.name)
      )
        continue;
      const path = resolve(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("typecheck-source-symlink");
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && SOURCE_EXTENSION.test(item.name))
        files.push(path);
    }
  };
  visit(resolve(root, "test"));
  visit(resolve(root, "cloud/tests"));
  if (existsSync(resolve(root, "types"))) visit(resolve(root, "types"));
  for (const item of readdirSync(root, { withFileTypes: true }))
    if (item.isFile() && /\.config\.(?:[cm]?js|[cm]?ts)$/.test(item.name))
      files.push(resolve(root, item.name));
  return files.sort();
}

function unsafeAnnotations(source: ts.SourceFile): string[] {
  const issues = new Set<string>(),
    nodes = new Set<ts.Node>(),
    comments = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (nodes.has(node)) return;
    nodes.add(node);
    if (
      [
        ts.SyntaxKind.AnyKeyword,
        ts.SyntaxKind.JSDocAllType,
        ts.SyntaxKind.JSDocUnknownType,
      ].includes(node.kind)
    )
      issues.add("explicit-any");
    for (const comment of ts.getLeadingCommentRanges(
      source.text,
      node.getFullStart(),
    ) ?? []) {
      if (comments.has(comment.pos)) continue;
      comments.add(comment.pos);
      const body = source.text
        .slice(comment.pos, comment.end)
        .replace(/^\/\/\/?|^\/\*\*?/, "");
      if (/(?:^|\n)\s*\*?\s*@ts-(?:nocheck|ignore|expect-error)\b/.test(body))
        issues.add("typecheck-suppression");
    }
    ts.forEachChild(node, visit);
    for (const doc of ts.getJSDocCommentsAndTags(node)) visit(doc);
  };
  visit(source);
  return [...issues];
}

export function inspectTypecheckCoverage(root = ROOT) {
  const required = maintainedTestAndConfigFiles(root),
    covered = new Set<string>(),
    checked = checkedProjects(root);
  const unsafe: { file: string; issues: string[] }[] = [];
  const declarationErrors = new Map<
    string,
    { file: string; code: number; message: string }
  >();
  for (const path of checked) {
    const config = ts.readConfigFile(path, ts.sys.readFile);
    if (config.error)
      throw new Error(`typecheck-config-invalid:${relative(root, path)}`);
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(path),
    );
    if (parsed.errors.length)
      throw new Error(`typecheck-config-invalid:${relative(root, path)}`);
    const strict =
      parsed.options.noCheck !== true &&
      STRICT_FLAGS.every(
        (flag) => (parsed.options[flag] ?? parsed.options.strict) === true,
      ) &&
      parsed.options.noUncheckedIndexedAccess === true &&
      parsed.options.exactOptionalPropertyTypes === true;
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const paths = new Set(
      program.getSourceFiles().map((file) => resolve(file.fileName)),
    );
    const declarations = required.filter(
      (file) => /\.d\.[cm]?ts$/.test(file) && paths.has(file),
    );
    if (declarations.length) {
      const declarationProgram = ts.createProgram(parsed.fileNames, {
        ...parsed.options,
        skipLibCheck: false,
      });
      for (const file of declarations) {
        const source = declarationProgram.getSourceFile(file);
        if (!source) throw new Error("typecheck-declaration-missing");
        for (const diagnostic of [
          ...declarationProgram.getSyntacticDiagnostics(source),
          ...declarationProgram.getSemanticDiagnostics(source),
        ]) {
          const entry = {
            file: relative(root, file),
            code: diagnostic.code,
            message: ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            ),
          };
          declarationErrors.set(JSON.stringify(entry), entry);
        }
      }
    }
    for (const file of required) {
      if (
        !strict ||
        !paths.has(file) ||
        (/\.(?:[cm]?js|jsx)$/.test(file) && parsed.options.checkJs !== true)
      )
        continue;
      covered.add(file);
    }
  }
  for (const file of required) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const issues = unsafeAnnotations(source);
    if (issues.length) unsafe.push({ file: relative(root, file), issues });
  }
  return {
    projects: checked.map((path) => relative(root, path)),
    requiredFiles: required.map((path) => relative(root, path)),
    missingFiles: required
      .filter((path) => !covered.has(path))
      .map((path) => relative(root, path)),
    unsafe,
    declarationErrors: [...declarationErrors.values()],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = inspectTypecheckCoverage();
  if (
    result.missingFiles.length ||
    result.unsafe.length ||
    result.declarationErrors.length
  ) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else
    console.log(
      `Strict semantic coverage: ${result.requiredFiles.length} maintained test/config files in ${result.projects.length} compiler projects.`,
    );
}
