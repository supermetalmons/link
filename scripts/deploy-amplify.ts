const { spawnSync } = require("node:child_process");

type CliOptions = {
  appId?: string;
  branch?: string;
  region?: string;
  profile?: string;
  jobType: "RELEASE" | "RETRY";
  dryRun: boolean;
  wait: boolean;
};

const DEFAULT_AMPLIFY_APP_ID = "d3r5xb00dg3htl";

function usage(): string {
  return [
    "Trigger a frontend build/deploy for a git branch in AWS Amplify.",
    "",
    "Usage:",
    "  npm run deploy --branch production",
    "  npm run deploy -- --branch production",
    "  npm run deploy -- production",
    "  npm run deploy -- production --wait",
    "",
    "Optional:",
    "  --app-id <id>                 # override Amplify app id",
    "  --region <region>",
    "  --profile <profile>",
    "  --job-type RELEASE|RETRY      # default RELEASE",
    "  --dry-run",
    "  --wait                        # wait for Amplify job to finish",
    "",
    "Environment:",
    "  AMPLIFY_APP_ID, AMPLIFY_REGION, AWS_PROFILE, AWS_REGION, AWS_DEFAULT_REGION",
  ].join("\n");
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n[deploy] ${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    jobType: "RELEASE",
    dryRun: false,
    wait: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--branch") {
      const value = argv[++i];
      if (!value) fail("Missing value for --branch");
      opts.branch = value;
      continue;
    }

    if (arg === "-b") {
      const value = argv[++i];
      if (!value) fail("Missing value for -b");
      opts.branch = value;
      continue;
    }

    if (arg === "--app-id") {
      const value = argv[++i];
      if (!value) fail("Missing value for --app-id");
      opts.appId = value;
      continue;
    }

    if (arg === "--region") {
      const value = argv[++i];
      if (!value) fail("Missing value for --region");
      opts.region = value;
      continue;
    }

    if (arg === "--profile") {
      const value = argv[++i];
      if (!value) fail("Missing value for --profile");
      opts.profile = value;
      continue;
    }

    if (arg === "--job-type") {
      const value = argv[++i];
      if (value !== "RELEASE" && value !== "RETRY")
        fail(`Invalid --job-type ${JSON.stringify(value)}`);
      opts.jobType = value;
      continue;
    }

    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }

    if (arg === "--wait") {
      opts.wait = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (!opts.branch) {
        opts.branch = arg;
        continue;
      }
      fail(`Unexpected extra arg: ${arg}\n\n${usage()}`, 2);
    }

    fail(`Unknown arg: ${arg}\n\n${usage()}`, 2);
  }

  return opts;
}

function awsCli(
  globalArgs: string[],
  amplifyArgs: string[],
  mode: "pipe" | "inherit" = "inherit",
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("aws", [...globalArgs, "amplify", ...amplifyArgs], {
    encoding: "utf8",
    stdio: mode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AWS_PAGER: "",
    },
  });

  if ((res as { error?: { code?: string } }).error?.code === "ENOENT") {
    fail(
      "AWS CLI not found. Install it (or ensure `aws` is in PATH) and try again.",
    );
  }

  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function formatAwsFailure(
  operation: string,
  result: { status: number; stdout: string; stderr: string },
  context: { region?: string; profile?: string } = {},
): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  const hints: string[] = [];

  if (/NoRegion|You must specify a region/i.test(combined)) {
    hints.push(
      "Set region via --region or AMPLIFY_REGION (for example: AMPLIFY_REGION=us-east-1).",
    );
  }
  if (
    /NotFoundException|Branch .* not found|App .* not found/i.test(combined)
  ) {
    hints.push(
      "Verify the Amplify app id (--app-id or AMPLIFY_APP_ID) and the branch name.",
    );
  }
  if (
    /NoCredentials|Unable to locate credentials|UnrecognizedClientException|ExpiredToken/i.test(
      combined,
    )
  ) {
    hints.push(
      "Authenticate AWS CLI (for example: aws configure sso, then aws sso login --profile <name>; or aws configure).",
    );
  }
  if (!context.region) {
    hints.push(
      "No region provided via --region, AMPLIFY_REGION, AWS_REGION, or AWS_DEFAULT_REGION.",
    );
  }
  if (!context.profile) {
    hints.push(
      "No profile provided via --profile or AWS_PROFILE (default profile will be used if configured).",
    );
  }

  const lines = [`${operation}.`];
  if (combined) {
    lines.push("", "AWS CLI output:", combined);
  }
  if (hints.length > 0) {
    lines.push("", "Hints:", ...hints.map((hint) => `- ${hint}`));
  }
  return lines.join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const appId =
    opts.appId || process.env.AMPLIFY_APP_ID || DEFAULT_AMPLIFY_APP_ID;
  const branch = opts.branch || process.env.npm_config_branch;
  if (!branch) fail("Missing required arg: --branch <name>\n\n" + usage(), 2);

  const region =
    opts.region ||
    process.env.AMPLIFY_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;
  const profile = opts.profile || process.env.AWS_PROFILE;

  const awsGlobalArgs: string[] = [];
  if (profile) awsGlobalArgs.push("--profile", profile);
  if (region) awsGlobalArgs.push("--region", region);
  awsGlobalArgs.push("--no-cli-pager");

  console.log(`[deploy] Amplify app: ${appId}`);
  console.log(`[deploy] Branch:      ${branch}`);
  if (region) console.log(`[deploy] Region:      ${region}`);
  if (profile) console.log(`[deploy] Profile:     ${profile}`);

  if (opts.dryRun) {
    console.log("\n[deploy] --dry-run: would start Amplify job.");
    return;
  }

  const start = awsCli(
    awsGlobalArgs,
    [
      "start-job",
      "--app-id",
      appId,
      "--branch-name",
      branch,
      "--job-type",
      opts.jobType,
      "--output",
      "json",
    ],
    "pipe",
  );
  if (start.status !== 0) {
    fail(
      formatAwsFailure(
        "Failed to start Amplify job (aws amplify start-job)",
        start,
        { region, profile },
      ),
    );
  }

  let jobId: string | undefined;
  try {
    const payload = JSON.parse(start.stdout);
    jobId = payload?.jobSummary?.jobId;
  } catch {}

  if (start.stdout.trim()) {
    console.log(`\n${start.stdout.trim()}\n`);
  }

  if (!jobId) {
    console.log("[deploy] Started job (jobId not parsed).");
    console.log("[deploy] Tip: re-run with --wait to poll status.");
    return;
  }

  console.log(`[deploy] Started job: ${jobId}`);

  if (!opts.wait) {
    console.log(
      "[deploy] Tip: re-run with --wait to poll status until completion.",
    );
    return;
  }

  console.log("[deploy] Waiting for job to finish...");
  const pollEveryMs = 10_000;
  const maxMs = 30 * 60_000;
  const startAt = Date.now();

  while (true) {
    if (Date.now() - startAt > maxMs) {
      fail(
        `Timed out waiting for job ${jobId} after ${Math.round(maxMs / 60_000)} minutes.`,
      );
    }

    const job = awsCli(
      awsGlobalArgs,
      [
        "get-job",
        "--app-id",
        appId,
        "--branch-name",
        branch,
        "--job-id",
        jobId,
        "--output",
        "json",
      ],
      "pipe",
    );
    if (job.status !== 0) {
      fail(
        formatAwsFailure(
          "Failed to poll job status (aws amplify get-job)",
          job,
          { region, profile },
        ),
      );
    }

    let status = "UNKNOWN";
    try {
      const payload = JSON.parse(job.stdout);
      status =
        payload?.job?.summary?.status || payload?.jobSummary?.status || status;
    } catch {}

    console.log(`[deploy] Job status: ${status}`);
    if (status === "SUCCEED" || status === "SUCCEEDED") return;
    if (status === "FAILED" || status === "CANCELLED") process.exit(1);

    await sleep(pollEveryMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
