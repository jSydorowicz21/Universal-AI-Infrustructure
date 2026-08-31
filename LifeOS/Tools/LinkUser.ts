#!/usr/bin/env bun

/**
 * LinkUser - Setup step 6. Establishes the system/private-data separation contract:
 * `<configRoot>/LIFEOS/USER` and `<configRoot>/LIFEOS/MEMORY` become symlinks
 * to their canonical homes under `<configDir>`. Migrates either live tree first,
 * preserving displaced destination files, then verifies both links. Idempotent.
 * Refuses on a dev tree unless --allow-dev.
 *
 * Usage:
 *   bun LinkUser.ts [--config-root <dir>] [--config-dir <dir>] [--apply] [--allow-dev]
 */

import { join } from "node:path";
import { checkMemorySymlinkContract, checkSymlinkContract, detectDevTree, resolveInstallRoots, setupMemorySeparation, setupUserSeparation } from "./InstallEngine";



function main(): void {
  const a = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const roots = resolveInstallRoots();
  const configRoot = get("--config-root") || roots.configRoot;
  const configDir = get("--config-dir") || roots.dataRoot;
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({ ok: false, refused: "dev-tree", detail: `${configRoot} is a source tree — refusing to relink.` }, null, 2));
    process.exit(2);
  }

  if (!apply) {
    const contract = checkSymlinkContract(configRoot, configDir);
    const memoryContract = checkMemorySymlinkContract(configRoot, configDir);
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      currentContract: contract,
      currentMemoryContract: memoryContract,
      willLink: `${join(configRoot, "LIFEOS", "USER")} → ${join(configDir, "USER")}`,
      willLinkMemory: `${join(configRoot, "LIFEOS", "MEMORY")} → ${join(configDir, "MEMORY")}`,
    }, null, 2));
    process.exit(0);
  }

  const result = setupUserSeparation(configRoot, configDir);
  const memory = setupMemorySeparation(configRoot, configDir);
  const contract = checkSymlinkContract(configRoot, configDir);
  const memoryContract = checkMemorySymlinkContract(configRoot, configDir);
  const ok = contract.passed && memoryContract.passed && !result.error && !memory.error;
  console.log(JSON.stringify({ ok, written: true, ...result, contract, memory, memoryContract }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
