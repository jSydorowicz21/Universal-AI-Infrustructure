#!/usr/bin/env bun
/**
 * JunctionSafeUpdateSmokeTest
 *
 * Regression guard for the destructive dev-install blocker: the installed
 * updater used to check only the immediate destination for a reparse point, so
 * a plain directory target sitting under a junctioned/symlinked ancestor (e.g.
 * `installRoot/PAI` -> source repo) was recursively deleted THROUGH the junction,
 * destroying real source files.
 *
 * This builds a dev-style install where `installRoot/PAI` is a junction (Windows)
 * or symlink (POSIX) back into a source fixture, then runs the real updater with
 * a tiny manifest and proves:
 *   1. Source fixture files survive untouched and the updater skips safely.
 *   2. When the junction resolves to a DIFFERENT (foreign) tree, the updater
 *      fails clearly instead of deleting through it, and the foreign tree
 *      survives.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = { name: string; passed: boolean; detail: string };

const checks: Check[] = [];
function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

const keep = process.argv.includes("--keep");
const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const root = join(tmpdir(), `pai-junction-safe-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const linkType = process.platform === "win32" ? "junction" : "dir";
const LIB_SENTINEL = "SOURCE_LIB_SENTINEL_DO_NOT_DELETE";
const NOTE_SENTINEL = "SOURCE_NOTE_SENTINEL";

// A minimal release fixture that satisfies Resolve-ReleaseRoot (CLAUDE.md + PAI).
function buildReleaseFixture(dir: string): { manifestPath: string } {
  write(join(dir, "CLAUDE.md"), "**MANDATORY FIRST ACTION:** Read `$PAI_DIR/ALGORITHM/LATEST` from the active PAI subsystem directory.");
  write(join(dir, "PAI", "ALGORITHM", "LATEST"), "6.3.0");
  write(join(dir, "PAI", "ALGORITHM", "v6.3.0.md"), "# algorithm placeholder");
  write(join(dir, "PAI", "TOOLS", "lib", "keep.ts"), LIB_SENTINEL);
  write(join(dir, "PAI", "TOOLS", "lib", "nested", "deep.ts"), LIB_SENTINEL);
  write(join(dir, "PAI", "TOOLS", "note.ts"), NOTE_SENTINEL);
  const manifest = {
    version: 1,
    releaseRoot: ".",
    entries: [
      { source: "CLAUDE.md", targets: { claude: "CLAUDE.md" }, transformInstructions: true },
      { source: "PAI/TOOLS/lib", target: "PAI/TOOLS/lib" },
      { source: "PAI/TOOLS/note.ts", target: "PAI/TOOLS/note.ts" },
    ],
  };
  const manifestPath = join(dir, "hotfix-manifest.json");
  write(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath };
}

function runUpdater(args: { installRoot: string; sourceDir: string; manifestPath: string; home: string }) {
  const command = process.platform === "win32" ? "powershell" : "bash";
  const cliArgs = process.platform === "win32"
    ? [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(releaseRoot, "update-installed.ps1"),
        "-Framework", "claude", "-InstallRoot", args.installRoot,
        "-SourceDir", args.sourceDir, "-ManifestPath", args.manifestPath, "-NoPull",
      ]
    : [
        join(releaseRoot, "update-installed.sh"),
        "--framework", "claude", "--install-root", args.installRoot,
        "--source-dir", args.sourceDir, "--manifest-path", args.manifestPath, "--no-pull",
      ];
  return spawnSync(command, cliArgs, {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: args.home,
      USERPROFILE: args.home,
      OneDrive: join(args.home, "OneDrive"),
      CLAUDE_HOME: args.installRoot,
      PAI_DATA_DIR: join(args.home, ".pai"),
      PAI_CONFIG_DIR: join(args.home, ".config", "PAI"),
      PAI_FRAMEWORK_DIR: args.installRoot,
      PAI_FRAMEWORK: "claude",
      PAI_SKIP_USER_ENV_UPDATE: "1",
      PAI_USER_ENV_TARGET: "Process",
    },
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: dev install junctions installRoot/PAI back at the managed source.
// The updater must leave the source dir untouched and skip safely.
// ---------------------------------------------------------------------------
const sourceFixture = join(root, "source", ".claude");
const { manifestPath } = buildReleaseFixture(sourceFixture);

const installRoot = join(root, "install", ".claude");
const home = join(root, "home");
mkdirSync(installRoot, { recursive: true });
mkdirSync(home, { recursive: true });
// Dev-style junction: installRoot/PAI -> sourceFixture/PAI (the source repo subtree).
symlinkSync(join(sourceFixture, "PAI"), join(installRoot, "PAI"), linkType);

const update1 = runUpdater({ installRoot, sourceDir: sourceFixture, manifestPath, home });

const sourceLib = join(sourceFixture, "PAI", "TOOLS", "lib", "keep.ts");
const sourceLibDeep = join(sourceFixture, "PAI", "TOOLS", "lib", "nested", "deep.ts");
const sourceNote = join(sourceFixture, "PAI", "TOOLS", "note.ts");

check("scenario1 updater exits cleanly", update1.status === 0, `status=${update1.status ?? "null"} ${(update1.stderr || "").split(/\r?\n/).slice(-3).join(" | ")}`);
check("scenario1 source lib file survives", read(sourceLib) === LIB_SENTINEL, sourceLib);
check("scenario1 source nested lib file survives", read(sourceLibDeep) === LIB_SENTINEL, sourceLibDeep);
check("scenario1 source note file survives", read(sourceNote) === NOTE_SENTINEL, sourceNote);
check("scenario1 PAI junction preserved", existsSync(join(installRoot, "PAI")), join(installRoot, "PAI"));
check(
  "scenario1 dir target skipped (not deleted through junction)",
  /unchanged|dev junction|left unchanged|dev symlink/i.test(`${update1.stdout || ""}${update1.stderr || ""}`),
  (update1.stdout || "").split(/\r?\n/).filter((l) => /unchanged|junction|symlink/i.test(l)).slice(-2).join(" | ") || "no skip line",
);

// ---------------------------------------------------------------------------
// Scenario 2: the junction resolves to a FOREIGN tree (not the managed source).
// The updater must fail clearly rather than recursively delete through it, and
// the foreign tree must survive.
// ---------------------------------------------------------------------------
const FOREIGN_SENTINEL = "FOREIGN_TREE_DO_NOT_DELETE";
const foreignTree = join(root, "foreign", "PAI");
write(join(foreignTree, "TOOLS", "lib", "precious.ts"), FOREIGN_SENTINEL);

const installRoot2 = join(root, "install2", ".claude");
const home2 = join(root, "home2");
mkdirSync(installRoot2, { recursive: true });
mkdirSync(home2, { recursive: true });
// Junction installRoot2/PAI -> a foreign tree that is NOT the manifest source.
symlinkSync(foreignTree, join(installRoot2, "PAI"), linkType);

const update2 = runUpdater({ installRoot: installRoot2, sourceDir: sourceFixture, manifestPath, home: home2 });
const foreignFile = join(foreignTree, "TOOLS", "lib", "precious.ts");

check("scenario2 updater fails on foreign junction", update2.status !== 0, `status=${update2.status ?? "null"}`);
check("scenario2 foreign tree survives (not deleted)", read(foreignFile) === FOREIGN_SENTINEL, foreignFile);
check(
  "scenario2 failure message names reparse ancestor",
  /reparse|symlink|junction/i.test(`${update2.stdout || ""}${update2.stderr || ""}`),
  (update2.stderr || "").split(/\r?\n/).filter((l) => /reparse|symlink|junction|refus/i.test(l)).slice(-2).join(" | ") || "no reason line",
);

// ---------------------------------------------------------------------------
// Scenario 3: the manifest TARGET LEAF itself is a junction/symlink that points
// at the managed source (installRoot/PAI/TOOLS/lib -> source lib), while its
// parents are plain dirs. The ancestor scan skips the leaf, so the updater must
// recognise the leaf link, skip it instead of copying a directory onto itself,
// and leave the source untouched.
// ---------------------------------------------------------------------------
const installRoot3 = join(root, "install3", ".claude");
const home3 = join(root, "home3");
mkdirSync(join(installRoot3, "PAI", "TOOLS"), { recursive: true });
mkdirSync(home3, { recursive: true });
symlinkSync(join(sourceFixture, "PAI", "TOOLS", "lib"), join(installRoot3, "PAI", "TOOLS", "lib"), linkType);

const update3 = runUpdater({ installRoot: installRoot3, sourceDir: sourceFixture, manifestPath, home: home3 });

check("scenario3 updater exits cleanly on same-source leaf link", update3.status === 0, `status=${update3.status ?? "null"} ${(update3.stderr || "").split(/\r?\n/).slice(-3).join(" | ")}`);
check("scenario3 source lib file survives", read(sourceLib) === LIB_SENTINEL, sourceLib);
check("scenario3 source nested lib file survives", read(sourceLibDeep) === LIB_SENTINEL, sourceLibDeep);
check("scenario3 leaf link preserved", existsSync(join(installRoot3, "PAI", "TOOLS", "lib")), join(installRoot3, "PAI", "TOOLS", "lib"));
check(
  "scenario3 leaf link skipped (not copied onto itself)",
  /unchanged|dev junction|left unchanged|dev symlink/i.test(`${update3.stdout || ""}${update3.stderr || ""}`),
  (update3.stdout || "").split(/\r?\n/).filter((l) => /unchanged|junction|symlink/i.test(l)).slice(-2).join(" | ") || "no skip line",
);

// ---------------------------------------------------------------------------
// Scenario 4: the manifest TARGET LEAF is a junction/symlink to a FOREIGN tree
// (not the managed source). The updater must fail rather than copy through the
// leaf link into the foreign tree, and the foreign tree must survive.
// ---------------------------------------------------------------------------
const LEAF_FOREIGN_SENTINEL = "LEAF_FOREIGN_DO_NOT_DELETE";
const leafForeign = join(root, "leaf-foreign", "lib");
write(join(leafForeign, "precious.ts"), LEAF_FOREIGN_SENTINEL);

const installRoot4 = join(root, "install4", ".claude");
const home4 = join(root, "home4");
mkdirSync(join(installRoot4, "PAI", "TOOLS"), { recursive: true });
mkdirSync(home4, { recursive: true });
symlinkSync(leafForeign, join(installRoot4, "PAI", "TOOLS", "lib"), linkType);

const update4 = runUpdater({ installRoot: installRoot4, sourceDir: sourceFixture, manifestPath, home: home4 });
const leafForeignFile = join(leafForeign, "precious.ts");

check("scenario4 updater fails on foreign leaf link", update4.status !== 0, `status=${update4.status ?? "null"}`);
check("scenario4 foreign leaf tree survives (not deleted)", read(leafForeignFile) === LEAF_FOREIGN_SENTINEL, leafForeignFile);
check("scenario4 source lib untouched by foreign leaf run", read(sourceLib) === LIB_SENTINEL, sourceLib);
check(
  "scenario4 failure message names reparse leaf",
  /reparse|symlink|junction|leaf|refus/i.test(`${update4.stdout || ""}${update4.stderr || ""}`),
  (update4.stderr || "").split(/\r?\n/).filter((l) => /reparse|symlink|junction|leaf|refus/i.test(l)).slice(-2).join(" | ") || "no reason line",
);

if (keep) {
  console.log(`\nKept smoke root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} junction-safe update smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll junction-safe update smoke checks passed.");
