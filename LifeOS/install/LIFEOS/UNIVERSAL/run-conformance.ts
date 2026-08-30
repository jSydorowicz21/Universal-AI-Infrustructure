import { runConformance } from "./conformance";

const evidence = await runConformance({
  adapterId: "kernel",
  adapterVersion: "1.0.0",
  cliVersion: "fixture-1.0.0",
  osProfile: `${process.platform}:credential-free-fixture`,
  platformTier: process.platform === "darwin" ? "P1" : process.platform === "win32" ? "P3" : "P2",
  adapterClass: "compatibility",
});

if (!evidence.probes.every((probe) => probe.passed)) {
  console.error(JSON.stringify(evidence, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ schema: evidence.schema, scope: evidence.scope, evidenceUri: evidence.evidenceUri, passed: evidence.probes.length }, null, 2));
