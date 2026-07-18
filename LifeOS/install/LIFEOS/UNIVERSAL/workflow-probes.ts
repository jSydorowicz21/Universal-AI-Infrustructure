#!/usr/bin/env bun
const mode = process.argv[2];

if (mode === "layout") {
  const root = import.meta.dir;
  const required = [
    "index.ts",
    "contract.ts",
    "conformance.ts",
    "bootstrap.ts",
    "package.json",
    "schemas/uai.adapter.v1.schema.json",
  ];
  for (const relativePath of required) {
    if (!(await Bun.file(`${root}/${relativePath}`).exists())) throw new Error(`Missing current-layout file ${relativePath}`);
  }
  const workflowPath = `${root}/../../../../.github/workflows/pai-codex-validation.yml`;
  const workflow = Bun.YAML.parse(await Bun.file(workflowPath).text()) as Record<string, unknown>;
  if (!workflow || typeof workflow !== "object" || !workflow.jobs || typeof workflow.jobs !== "object") {
    throw new Error("Validation workflow must define jobs");
  }
  const rootIsolationVariables = ["HOME", "USERPROFILE", "UAI_DATA_DIR", "PAI_DATA_DIR", "UAI_CONFIG_DIR", "PAI_CONFIG_DIR"] as const;
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const workflowEnv = workflow.env;
  if (isRecord(workflowEnv)) {
    for (const [name, value] of Object.entries(workflowEnv)) {
      if (rootIsolationVariables.includes(name as typeof rootIsolationVariables[number])) {
        throw new Error(`Workflow-level env ${name} must not isolate runner roots`);
      }
      if (typeof value === "string" && /\$\{\{\s*runner\./.test(value)) {
        throw new Error(`Workflow-level env ${name} cannot use the runner context before a job starts`);
      }
    }
  }
  for (const [jobName, job] of Object.entries(workflow.jobs as Record<string, unknown>)) {
    if (!isRecord(job)) throw new Error(`Workflow job ${jobName} must be an object`);
    if (isRecord(job.env)) {
      for (const name of rootIsolationVariables) {
        if (name in job.env) throw new Error(`Job ${jobName} must not isolate runner roots`);
      }
    }
    if (!Array.isArray(job.steps)) throw new Error(`Workflow job ${jobName} must define steps`);
    const checkoutIndex = job.steps.findIndex((step) => isRecord(step) && typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
    const setupIndex = job.steps.findIndex((step) => isRecord(step) && typeof step.uses === "string" && step.uses.startsWith("oven-sh/setup-bun@"));
    for (const [index, step] of job.steps.entries()) {
      if (!isRecord(step)) throw new Error(`Workflow job ${jobName} step ${index + 1} must be an object`);
      const isBunRun = typeof step.run === "string" && /(?:^|\s)bun(?:\s|$)/.test(step.run);
      const stepEnv = isRecord(step.env) ? step.env : {};
      for (const name of rootIsolationVariables) {
        if (name in stepEnv && !isBunRun) throw new Error(`Workflow job ${jobName} step ${index + 1} may isolate roots only for Bun runs`);
      }
      if (!isBunRun) continue;
      if (checkoutIndex < 0 || setupIndex < 0 || index <= checkoutIndex || index <= setupIndex) {
        throw new Error(`Workflow job ${jobName} Bun step ${index + 1} must follow checkout and Bun setup`);
      }
      for (const name of rootIsolationVariables) {
        const value = stepEnv[name];
        if (typeof value !== "string" || !/\$\{\{\s*runner\.temp\s*\}\}/.test(value)) {
          throw new Error(`Workflow job ${jobName} Bun step ${index + 1} must isolate ${name} with runner.temp`);
        }
      }
    }
  }
  console.log(JSON.stringify({ ok: true, checked: required.length, mode }));
} else if (mode === "live-discovery") {
  const adapter = process.env.LIVE_ADAPTER;
  const cliByAdapter: Record<string, string> = { claude: "claude", omp: "omp", codex: "codex", opencode: "opencode" };
  const cli = adapter ? cliByAdapter[adapter] : undefined;
  if (!adapter || !cli) throw new Error("Unknown or missing LIVE_ADAPTER");
  const executable = Bun.which(cli);
  if (!executable) throw new Error(`${cli} is not installed on this runner`);
  const result = Bun.spawnSync([executable, "--version"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  console.log(JSON.stringify({ adapter, cliVersion: result.stdout.toString().trim(), scope: "connectivity-only" }));
} else {
  throw new Error("Usage: bun run workflow-probes.ts {layout|live-discovery}");
}
