import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL } from "../cloud/workers/api/src/profileTopologySql.ts";
import {
  manageProfileCanonical,
  parseArgs,
  type Control,
  type ControlState,
  type Dependencies,
} from "./manage-profile-canonical.ts";

test("profile canonical control accepts only one explicit operation", () => {
  for (const operation of ["status", "freeze", "resume", "audit"]) {
    assert.equal(parseArgs([`--${operation}`]), operation);
  }
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--freeze", "--status"]));
  assert.throws(() => parseArgs(["--audit", "--freeze"]));
  assert.throws(() => parseArgs(["--audit", "--audit"]));
  assert.throws(() => parseArgs(["--begin-import"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("profile canonical control follows the maintenance lifecycle", () => {
  let control: Control = { state: "active" };
  const logs: string[] = [];
  const dependencies = {
    log: (message: string) => logs.push(message),
    readControl: () => control,
    readTopologyAudit: () => assert.fail("must not audit"),
    updateState: (expected: ControlState, next: ControlState) => {
      assert.equal(control.state, expected);
      control = { state: next };
    },
  };
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  assert.equal(control.state, "active");
  assert.equal(logs.length, 4);
  assert.deepEqual(JSON.parse(logs[0]), {
    operation: "freeze",
    state: "frozen",
  });
});

test("profile canonical control treats repeated target states as idempotent", () => {
  let control: Control = { state: "active" };
  const dependencies = {
    log: () => undefined,
    readControl: () => control,
    readTopologyAudit: () => assert.fail("must not audit"),
    updateState: () => assert.fail("must not update"),
  };
  manageProfileCanonical("resume", dependencies);
  control = { state: "frozen" };
  manageProfileCanonical("freeze", dependencies);
});

test("profile canonical status reads control without updates or an audit", () => {
  const logs: string[] = [];
  manageProfileCanonical("status", {
    log: (message) => logs.push(message),
    readControl: () => ({ state: "active" }),
    readTopologyAudit: () => assert.fail("must not audit"),
    updateState: () => assert.fail("must not update"),
  });
  assert.deepEqual(
    logs.map((message) => JSON.parse(message)),
    [{ operation: "status", state: "active" }],
  );
});

const cleanAudit = {
  retiring_profile_without_matching_redirect: 0,
  active_profile_with_redirect: 0,
  login_owner_without_active_profile: 0,
  auth_method_without_active_profile: 0,
  recovery_job_without_active_profile: 0,
};

function auditDependencies(readTopologyAudit: () => unknown): {
  logs: string[];
  dependencies: Dependencies;
} {
  const logs: string[] = [];
  return {
    logs,
    dependencies: {
      log: (message) => logs.push(message),
      readControl: () => assert.fail("audit must not read control"),
      readTopologyAudit,
      updateState: () => assert.fail("audit must not update control"),
    },
  };
}

test("profile topology audit reports all clean counts with one read", () => {
  let reads = 0;
  const { logs, dependencies } = auditDependencies(() => {
    reads++;
    return [cleanAudit];
  });
  manageProfileCanonical("audit", dependencies);
  assert.equal(reads, 1);
  assert.deepEqual(
    logs.map((message) => JSON.parse(message)),
    [{ operation: "audit", ok: true, violations: cleanAudit }],
  );
});

for (const kind of Object.keys(cleanAudit)) {
  test(`profile topology audit reports and rejects ${kind}`, () => {
    const violations = { ...cleanAudit, [kind]: 2 };
    const { logs, dependencies } = auditDependencies(() => [violations]);
    assert.throws(
      () => manageProfileCanonical("audit", dependencies),
      /topology violations detected/,
    );
    assert.deepEqual(
      logs.map((message) => JSON.parse(message)),
      [{ operation: "audit", ok: false, violations }],
    );
  });
}

test("profile topology audit fails closed on malformed or missing counts", () => {
  const malformed = [
    undefined,
    null,
    {},
    [],
    [null],
    [[]],
    [cleanAudit, cleanAudit],
    ...[undefined, null, "0", -1, 0.5, NaN, Infinity, 2 ** 53].map((count) => [
      { ...cleanAudit, login_owner_without_active_profile: count },
    ]),
  ];
  for (const rows of malformed) {
    const { logs, dependencies } = auditDependencies(() => rows);
    assert.throws(
      () => manageProfileCanonical("audit", dependencies),
      /invalid profile canonical topology audit/,
    );
    assert.deepEqual(logs, []);
  }
});

test("profile topology audit propagates read failures without reporting success", () => {
  const { logs, dependencies } = auditDependencies(() => {
    throw new Error("audit read failed");
  });
  assert.throws(
    () => manageProfileCanonical("audit", dependencies),
    /audit read failed/,
  );
  assert.deepEqual(logs, []);
});

function runAuditCli(stdout: unknown, status = 0) {
  const preload = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    let calls = 0;
    childProcess.spawnSync = (_command, args) => {
      calls++;
      if (args[args.indexOf("--command") + 1] !== ${JSON.stringify(CANONICAL_PROFILE_TOPOLOGY_AUDIT_SQL)}) {
        throw new Error("unexpected audit SQL");
      }
      return ${JSON.stringify({ status, stdout: JSON.stringify(stdout) })};
    };
    syncBuiltinESMExports();
    process.on("exit", () => {
      if (calls !== 1) {
        process.stderr.write("audit must run exactly one query");
        process.exitCode = 99;
      }
    });
  `;
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      resolve(import.meta.dirname, "manage-profile-canonical.ts"),
      "--audit",
    ],
    { encoding: "utf8" },
  );
}

test("profile topology audit CLI exits successfully for a clean read-only query", () => {
  const child = runAuditCli([{ success: true, results: [cleanAudit] }]);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    operation: "audit",
    ok: true,
    violations: cleanAudit,
  });
});

test("profile topology audit CLI exits unsuccessfully after reporting violations", () => {
  const violations = { ...cleanAudit, active_profile_with_redirect: 1 };
  const child = runAuditCli([{ success: true, results: [violations] }]);
  assert.equal(child.status, 1, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    operation: "audit",
    ok: false,
    violations,
  });
  assert.match(child.stderr, /topology violations detected/);
});

test("profile topology audit CLI exits unsuccessfully for failed or malformed reads", () => {
  for (const [response, status] of [
    [[{ success: true, results: [cleanAudit] }], 1],
    [[{ success: false, results: [cleanAudit] }], 0],
    [[{ success: true, results: [{}] }], 0],
    [[], 0],
    [{ results: [cleanAudit] }, 0],
    [[{ results: [cleanAudit] }], 0],
  ] as const) {
    const child = runAuditCli(response, status);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /failed|invalid/);
  }
});
