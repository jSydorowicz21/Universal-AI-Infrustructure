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
  const workflowEnv = workflow.env;
  if (workflowEnv && typeof workflowEnv === "object" && !Array.isArray(workflowEnv)) {
    for (const [name, value] of Object.entries(workflowEnv)) {
      if (typeof value === "string" && /\$\{\{\s*runner\./.test(value)) {
        throw new Error(`Workflow-level env ${name} cannot use the runner context before a job starts`);
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
