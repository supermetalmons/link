const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  existsSync,
  readFileSync,
  readdirSync,
}: typeof import("node:fs") = require("node:fs");
const {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const typescript: typeof import("typescript") = require("typescript");

const repositoryRoot = resolve(__dirname, "..");
const sourceRoot = resolve(repositoryRoot, "src");
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx"];
type DependencyGraphKind = "runtime-static" | "all-static" | "mixed";
type DependencyMetadata = {
  runtimeStatic: string[];
  allStatic: string[];
  dynamic: string[];
};

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (sourceExtensions.includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

function isTypeOnlyImport(
  node: import("typescript").ImportDeclaration,
): boolean {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name || !clause.namedBindings) {
    return false;
  }
  return (
    typescript.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(
  node: import("typescript").ExportDeclaration,
): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  return (
    node.exportClause !== undefined &&
    typescript.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function collectDependencyMetadata(path: string): DependencyMetadata {
  const source = typescript.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    typescript.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? typescript.ScriptKind.TSX
      : typescript.ScriptKind.TS,
  );
  const runtimeStatic: string[] = [];
  const allStatic: string[] = [];
  const dynamic: string[] = [];
  for (const statement of source.statements) {
    if (
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier)
    ) {
      allStatic.push(statement.moduleSpecifier.text);
      if (!isTypeOnlyImport(statement)) {
        runtimeStatic.push(statement.moduleSpecifier.text);
      }
    }
    if (
      typescript.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      typescript.isStringLiteral(statement.moduleSpecifier)
    ) {
      allStatic.push(statement.moduleSpecifier.text);
      if (!isTypeOnlyExport(statement)) {
        runtimeStatic.push(statement.moduleSpecifier.text);
      }
    }
  }
  function visit(node: import("typescript").Node): void {
    if (
      typescript.isCallExpression(node) &&
      node.expression.kind === typescript.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      typescript.isStringLiteralLike(node.arguments[0])
    ) {
      dynamic.push(node.arguments[0].text);
    }
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      typescript.isStringLiteralLike(node.arguments[0])
    ) {
      dynamic.push(node.arguments[0].text);
    }
    typescript.forEachChild(node, visit);
  }
  visit(source);
  return { runtimeStatic, allStatic, dynamic };
}

function isFirestoreDependency(specifier: string): boolean {
  return [
    "@firebase/firestore",
    "firebase/compat/firestore",
    "firebase/firestore",
  ].some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

const sourceFiles = collectSourceFiles(sourceRoot);
const dependencyMetadataByPath = new Map(
  sourceFiles.map((path) => [path, collectDependencyMetadata(path)]),
);

function dependencySpecifiers(
  path: string,
  kind: DependencyGraphKind,
): string[] {
  const metadata =
    dependencyMetadataByPath.get(path) ?? collectDependencyMetadata(path);
  if (kind === "runtime-static") {
    return metadata.runtimeStatic;
  }
  if (kind === "all-static") {
    return metadata.allStatic;
  }
  return [...metadata.allStatic, ...metadata.dynamic];
}

function resolveSourceImport(
  importer: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const unresolved = resolve(dirname(importer), specifier);
  const importedExtension = extname(unresolved);
  const extensionless = sourceExtensions.includes(importedExtension)
    ? unresolved.slice(0, -importedExtension.length)
    : unresolved;
  const candidates = importedExtension
    ? [
        unresolved,
        ...sourceExtensions.map((extension) => extensionless + extension),
      ]
    : [
        unresolved,
        ...sourceExtensions.map((extension) => unresolved + extension),
        ...sourceExtensions.map((extension) =>
          join(unresolved, `index${extension}`),
        ),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

function buildGraph(
  files: string[],
  kind: DependencyGraphKind,
): Map<string, string[]> {
  const fileSet = new Set(files);
  return new Map(
    files.map((file) => [
      file,
      [
        ...new Set(
          dependencySpecifiers(file, kind)
            .map((specifier) => resolveSourceImport(file, specifier))
            .filter(
              (dependency): dependency is string =>
                dependency !== undefined && fileSet.has(dependency),
            ),
        ),
      ].sort(),
    ]),
  );
}

function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(node: string): void {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, indexes.get(dependency)!),
        );
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) {
      return;
    }
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component.sort());
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) {
      visit(node);
    }
  }
  return components;
}

function findCyclePath(
  component: string[],
  graph: Map<string, string[]>,
): string[] {
  const members = new Set(component);
  for (const start of component) {
    const path = [start];
    const onPath = new Set(path);

    function visit(node: string): string[] | undefined {
      for (const dependency of graph.get(node) ?? []) {
        if (!members.has(dependency)) {
          continue;
        }
        if (dependency === start) {
          return [...path, start];
        }
        if (onPath.has(dependency)) {
          continue;
        }
        path.push(dependency);
        onPath.add(dependency);
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
        onPath.delete(dependency);
        path.pop();
      }
      return undefined;
    }

    const cycle = visit(start);
    if (cycle) {
      return cycle;
    }
  }
  throw new Error("Strongly connected component did not contain a cycle.");
}

function displayPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function assertAcyclic(kind: DependencyGraphKind): void {
  const graph = buildGraph(sourceFiles, kind);
  const cyclicComponents = stronglyConnectedComponents(graph).filter(
    (component) =>
      component.length > 1 ||
      (component.length === 1 &&
        graph.get(component[0])?.includes(component[0])),
  );
  if (cyclicComponents.length === 0) {
    assert.ok(true);
    return;
  }

  const paths = cyclicComponents
    .map((component) => findCyclePath(component, graph).map(displayPath))
    .sort((left, right) => left.join(" -> ").localeCompare(right.join(" -> ")));
  assert.fail(
    `${kind} import cycles:\n${paths.map((path) => `- ${path.join(" -> ")}`).join("\n")}`,
  );
}

test("client runtime static imports are acyclic", () => {
  assertAcyclic("runtime-static");
});

test("client static imports including type-only edges are acyclic", () => {
  assertAcyclic("all-static");
});

test("client mixed static and literal dynamic imports are acyclic", () => {
  assertAcyclic("mixed");
});

test("client does not depend on Firestore", () => {
  const importers = sourceFiles
    .filter((path) =>
      dependencySpecifiers(path, "mixed").some(isFirestoreDependency),
    )
    .map(displayPath);

  assert.deepEqual(importers, []);
  for (const specifier of [
    "@firebase/firestore",
    "firebase/compat/firestore",
    "firebase/firestore/lite",
  ]) {
    assert.equal(isFirestoreDependency(specifier), true);
  }
});

test("client mixed graph includes no-substitution template imports", () => {
  assert.ok(
    dependencySpecifiers(
      resolve(sourceRoot, "game/board.ts"),
      "mixed",
    ).includes("../assets/monsSprites"),
  );
});

test("structural game-session mutations stay behind the gameplay API", () => {
  const connectionSource = readFileSync(
    resolve(sourceRoot, "connection/connection.ts"),
    "utf8",
  );
  for (const api of [
    "createInviteViaApi",
    "joinInviteViaApi",
    "proposeRematchViaApi",
    "endRematchViaApi",
    "ensureMatchViaApi",
  ]) {
    assert.match(connectionSource, new RegExp(`\\b${api}\\b`));
  }
  assert.doesNotMatch(connectionSource, /await update\(ref\(this\.db\)/);
  assert.doesNotMatch(connectionSource, /createGuestMatchFromHost/);
  assert.doesNotMatch(connectionSource, /runTransaction\(\s*guestIdRef/);

  const connectSource = connectionSource.slice(
    connectionSource.indexOf("public connectToGame"),
    connectionSource.indexOf(
      "public tryNavigateWatchOnlyToLatestApprovedMatch",
    ),
  );
  assert.ok(
    connectSource.indexOf("fetchInviteWithPendingCreation") <
      connectSource.indexOf("joinInviteViaApi"),
  );
  assert.match(connectSource, /getUserBoundAuthTokenProvider\(uid\)/);

  const rematchSource = connectionSource.slice(
    connectionSource.indexOf("public sendRematchProposal"),
    connectionSource.indexOf("public rematchSeriesEndIsIndicated"),
  );
  assert.ok(
    rematchSource.indexOf("proposeRematchViaApi") <
      rematchSource.indexOf("stopObservingAllMatches"),
  );
  assert.match(
    rematchSource,
    /getUserBoundAuthTokenProvider\(\s*writableContext\.loginUid,?\s*\)/,
  );
  assert.match(rematchSource, /pendingRematchProposal/);

  const createInviteSource = connectionSource.slice(
    connectionSource.indexOf("public async createInvite"),
    connectionSource.indexOf("private observeRematchOrEndMatchIndicators"),
  );
  assert.match(createInviteSource, /getUserBoundAuthTokenProvider\(uid\)/);
});

test("navigation history stays on the profile-scoped gameplay API", () => {
  const connectionSource = readFileSync(
    resolve(sourceRoot, "connection/connection.ts"),
    "utf8",
  );
  const bottomControlsSource = readFileSync(
    resolve(sourceRoot, "ui/BottomControls.tsx"),
    "utf8",
  );
  const cacheSource = readFileSync(
    resolve(sourceRoot, "services/navigationGamesCache.ts"),
    "utf8",
  );

  assert.match(connectionSource, /readNavigationGamesViaApi/);
  assert.doesNotMatch(connectionSource, /getCurrentLoginFallbackGames/);
  assert.doesNotMatch(connectionSource, /navigation:fallback/);
  assert.doesNotMatch(bottomControlsSource, /getCurrentLoginFallbackGames/);
  assert.doesNotMatch(bottomControlsSource, /isNavigationFallbackScope/);
  assert.doesNotMatch(cacheSource, /kind:\s*"login"/);
  assert.doesNotMatch(cacheSource, /scopeKey:\s*`login:/);
});
