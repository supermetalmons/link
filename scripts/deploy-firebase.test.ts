const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");

const { deployFirebase, parseArgs } = require("./deploy-firebase.ts") as {
  deployFirebase: (
    options: { dryRun: boolean; project: string },
    dependencies: {
      cloudDirectory: string;
      log(message: string): void;
      spawn(
        command: string,
        args: readonly string[],
        options: import("node:child_process").SpawnSyncOptions,
      ): { status: number | null } | undefined;
    },
  ) => void;
  parseArgs: (argv: string[]) => { dryRun: boolean; project: string };
};

test("parses only explicit Firebase rule deployments", () => {
  assert.deepEqual(parseArgs(["--project", "mons-link", "--dry-run"]), {
    dryRun: true,
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--project=mons-link"]), {
    dryRun: false,
    project: "mons-link",
  });
  for (const args of [[], ["--project"], ["--unknown"], ["function-name"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("dry-run previews only database rules without spawning", () => {
  const logs: string[] = [];
  let spawns = 0;
  deployFirebase(
    { dryRun: true, project: "mons-link" },
    {
      cloudDirectory: "/cloud",
      log: (message) => logs.push(message),
      spawn: () => {
        spawns += 1;
        return { status: 0 };
      },
    },
  );
  assert.equal(spawns, 0);
  assert.deepEqual(logs, [
    "[firebase] firebase deploy --only database --project mons-link",
  ]);
});

test("deploys only database rules from the cloud directory", () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  deployFirebase(
    { dryRun: false, project: "mons-link" },
    {
      cloudDirectory: "/cloud",
      log: () => undefined,
      spawn: (command, args, options) => {
        assert.equal(command, "firebase");
        calls.push({ args: args || [], cwd: String(options?.cwd) });
        return { status: 0 };
      },
    },
  );
  assert.deepEqual(calls, [
    {
      args: ["deploy", "--only", "database", "--project", "mons-link"],
      cwd: "/cloud",
    },
  ]);
});
