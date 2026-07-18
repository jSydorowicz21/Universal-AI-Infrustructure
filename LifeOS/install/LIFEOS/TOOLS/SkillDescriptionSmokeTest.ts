#!/usr/bin/env bun
/**
 * SkillDescriptionSmokeTest - validate skill frontmatter stays loader-safe.
 *
 * Codex rejects SKILL.md descriptions over 1024 characters. PAI's canonical
 * skill guidance is stricter: descriptions should stay at or below 650 chars.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");
const DESCRIPTION_LIMIT = 650;

type Finding = {
  skill: string;
  reason: string;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function descriptionFor(path: string): string | null {
  const text = readFileSync(path, "utf-8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^description:\s*(.*)$/m);
  return match ? unquote(match[1]) : null;
}

const findings: Finding[] = [];

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
  if (!existsSync(skillPath)) continue;

  const description = descriptionFor(skillPath);
  if (!description) {
    findings.push({ skill: entry.name, reason: "missing frontmatter description" });
    continue;
  }

  if (description.length > DESCRIPTION_LIMIT) {
    findings.push({
      skill: entry.name,
      reason: `description length ${description.length} exceeds ${DESCRIPTION_LIMIT}`,
    });
  }

  if (!description.includes("USE WHEN")) {
    findings.push({ skill: entry.name, reason: "description missing USE WHEN" });
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`FAIL ${finding.skill}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log("All skill descriptions are loader-safe.");
