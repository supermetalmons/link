const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const {
  basename,
  join,
  resolve,
}: typeof import("node:path") = require("node:path");
const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const test: typeof import("node:test") = require("node:test");

const cleaner = resolve(__dirname, "repo-clean.sh");
type TextSpawnResult = import("node:child_process").SpawnSyncReturns<string>;

type Fixture = {
  root: string;
  repository: string;
};

function run(command: string, args: string[], cwd: string): TextSpawnResult {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = run("git", args, cwd);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

function createFixture(initialBranch = "main"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mons-repo-clean-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", `--initial-branch=${initialBranch}`);
  git(repository, "config", "user.name", "Repository Cleaner Test");
  git(repository, "config", "user.email", "repo-clean@example.invalid");
  writeFileSync(join(repository, "fixture.txt"), "initial\n");
  git(repository, "add", "fixture.txt");
  git(repository, "commit", "-m", "initial");
  return { root, repository };
}

function removeFixture(fixture: Fixture): void {
  assert.match(basename(fixture.root), /^mons-repo-clean-/);
  rmSync(fixture.root, { recursive: true, force: true });
}

function runCleaner(repository: string): TextSpawnResult {
  assert.notEqual(resolve(repository), resolve(__dirname, ".."));
  return run("bash", [cleaner], repository);
}

function localBranches(repository: string): string[] {
  const output = git(
    repository,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  );
  return output ? output.split("\n").sort() : [];
}

function remoteBranches(repository: string, remote: string): string[] {
  const output = git(repository, "ls-remote", "--heads", "--refs", remote);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace("refs/heads/", ""))
    .filter((branch): branch is string => Boolean(branch))
    .sort();
}

test("keeps only main and keep/* local branches and clears stashes", () => {
  const fixture = createFixture();
  try {
    git(fixture.repository, "branch", "keep/local");
    git(fixture.repository, "branch", "feature/remove-me");
    appendFileSync(join(fixture.repository, "fixture.txt"), "stashed\n");
    git(fixture.repository, "stash", "push", "-m", "cleanup fixture");

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(localBranches(fixture.repository), ["keep/local", "main"]);
    assert.equal(git(fixture.repository, "stash", "list"), "");
    assert.match(result.stdout, /\[repo-clean\] Done\./);
  } finally {
    removeFixture(fixture);
  }
});

test("keeps only main, assets, and keep/* branches on local bare remotes", () => {
  const fixture = createFixture();
  try {
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    for (const branch of [
      "assets",
      "keep/remote",
      "delete/one",
      "delete/two",
    ]) {
      git(fixture.repository, "branch", branch);
    }
    git(fixture.repository, "remote", "add", "origin", remote);
    git(
      fixture.repository,
      "push",
      "origin",
      "main:main",
      "assets:assets",
      "keep/remote:keep/remote",
      "delete/one:delete/one",
      "delete/two:delete/two",
    );

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(remoteBranches(fixture.repository, remote), [
      "assets",
      "keep/remote",
      "main",
    ]);
  } finally {
    removeFixture(fixture);
  }
});

test("switches from a disposable current branch to an existing main", () => {
  const fixture = createFixture();
  try {
    git(fixture.repository, "switch", "-c", "topic");

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fixture.repository, "branch", "--show-current"), "main");
    assert.deepEqual(localBranches(fixture.repository), ["main"]);
    assert.match(result.stdout, /Switching to 'main' before branch cleanup/);
  } finally {
    removeFixture(fixture);
  }
});

test("creates main from the current branch when no fallback exists", () => {
  const fixture = createFixture("topic");
  try {
    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fixture.repository, "branch", "--show-current"), "main");
    assert.deepEqual(localBranches(fixture.repository), ["main"]);
    assert.match(result.stdout, /Creating 'main' from 'topic'/);
  } finally {
    removeFixture(fixture);
  }
});

test("creates main from origin/main when no kept local branch exists", () => {
  const fixture = createFixture("topic");
  try {
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repository, "remote", "add", "origin", remote);
    git(fixture.repository, "push", "-u", "origin", "topic:main");

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fixture.repository, "branch", "--show-current"), "main");
    assert.deepEqual(localBranches(fixture.repository), ["main"]);
    assert.match(
      result.stdout,
      /Creating 'main' from 'origin\/main' before cleanup/,
    );
    assert.deepEqual(remoteBranches(fixture.repository, remote), ["main"]);
  } finally {
    removeFixture(fixture);
  }
});

test("removes every non-primary worktree before deleting its branch", () => {
  const fixture = createFixture();
  try {
    const secondaryWorktree = join(fixture.root, "secondary-worktree");
    git(fixture.repository, "branch", "worktree-topic");
    git(
      fixture.repository,
      "worktree",
      "add",
      secondaryWorktree,
      "worktree-topic",
    );

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(secondaryWorktree), false);
    assert.deepEqual(localBranches(fixture.repository), ["main"]);
    assert.match(result.stdout, new RegExp(secondaryWorktree));
  } finally {
    removeFixture(fixture);
  }
});

test("aggregates remote deletion failures and continues other cleanup", () => {
  const fixture = createFixture();
  try {
    const remote = join(fixture.root, "remote.git");
    git(fixture.root, "init", "--bare", remote);
    git(fixture.repository, "branch", "delete-success");
    git(fixture.repository, "branch", "protected-failure");
    git(fixture.repository, "remote", "add", "origin", remote);
    git(
      fixture.repository,
      "push",
      "origin",
      "main:main",
      "delete-success:delete-success",
      "protected-failure:protected-failure",
    );
    const updateHook = join(remote, "hooks", "update");
    writeFileSync(
      updateHook,
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "refs/heads/protected-failure" && "$3" =~ ^0+$ ]]; then',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(updateHook, 0o755);

    const result = runCleaner(fixture.repository);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[repo-clean\] Completed with errors\./);
    assert.deepEqual(remoteBranches(fixture.repository, remote), [
      "main",
      "protected-failure",
    ]);
    assert.deepEqual(localBranches(fixture.repository), ["main"]);
  } finally {
    removeFixture(fixture);
  }
});
