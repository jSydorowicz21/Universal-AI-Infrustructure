#!/usr/bin/env bun
/**
 * CompactSkillDescriptions - keep SKILL.md descriptions loader-safe.
 *
 * Codex rejects descriptions over 1024 chars, and PAI's skill spec caps them
 * at 650. This rewrites only the YAML `description:` line, preserving skill
 * bodies and workflow files.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");
const LIMIT = 650;

const CURATED_DESCRIPTIONS: Record<string, string> = {
  Agents: "Compose, customize, and manage PAI agents, traits, observer roles, and team definitions. USE WHEN creating an agent, updating agent traits, composing specialist personas, spawning observer/team patterns, or reviewing agent system behavior. NOT FOR ordinary task delegation without changing agent definitions (use Delegation).",
  ApertureOscillation: "Shift between narrow, broad, analytical, creative, and synthesis views to escape local optima. USE WHEN stuck, overfocused, underexplored, framing a hard problem, needing alternate perspectives, or deliberately oscillating between detail and system-level views.",
  Aphorisms: "Create, extract, refine, and score compact aphorisms or memorable one-line ideas. USE WHEN writing aphorisms, turning notes into quotable lines, compressing wisdom, improving punchiness, or generating concise philosophical statements.",
  Apify: "Use Apify actors, datasets, and automation patterns for scraping and web workflows. USE WHEN running Apify jobs, choosing actors, scraping sites, extracting structured web data, or integrating Apify outputs into research or automation tasks.",
  Art: "Generate and edit static visual assets such as illustrations, diagrams, thumbnails, cards, icons, screenshots, and image variations. USE WHEN art, image generation, diagram, flowchart, infographic, header image, thumbnail, Mermaid, D3 chart, remove background, or wallpaper is requested. NOT FOR video or animation (use Remotion).",
  ArXiv: "Find, retrieve, summarize, and analyze academic papers from arXiv and related scholarly sources. USE WHEN searching papers, reviewing literature, comparing research claims, extracting methods/results, or grounding technical work in academic sources.",
  AudioEditor: "Edit, clean, assemble, and transform audio assets with repeatable commands and quality checks. USE WHEN trimming audio, normalizing levels, converting formats, removing silence/noise, preparing clips, or producing audio deliverables.",
  BeCreative: "Expand the option space with unusual ideas, analogies, synthetic examples, and creative reframes. USE WHEN brainstorming, escaping conventional answers, generating variants, inventing concepts, creating synthetic data, or deliberately seeking novelty.",
  BitterPillEngineering: "Apply hard-nosed engineering critique focused on incentives, fragility, hidden complexity, and failure modes. USE WHEN reviewing designs, challenging assumptions, simplifying systems, finding brittle abstractions, or making pragmatic tradeoff calls.",
  BrightData: "Use Bright Data scraping and browser/data collection capabilities for web intelligence tasks. USE WHEN scraping difficult sites, collecting public web data, using Bright Data tools, fetching pages at scale, or combining Bright Data with research workflows.",
  Browser: "Automate and verify browser interactions, local web apps, screenshots, and UI behavior. USE WHEN opening pages, clicking, typing, inspecting localhost, testing a frontend, taking screenshots, or validating visual/browser behavior.",
  ContextSearch: "Search local project, memory, and PAI context efficiently before acting. USE WHEN finding prior work, locating files, searching docs, retrieving context, answering from the repo, or avoiding stale assumptions.",
  Council: "Run structured multi-perspective review and deliberation among named viewpoints. USE WHEN asking for a council, panel, debate, critique from multiple stances, adversarial review, or synthesized recommendations from competing perspectives.",
  CreateCLI: "Design and scaffold TypeScript/Bun CLI tools with flags, help text, tests, and integration patterns. USE WHEN creating or improving a CLI, command tool, flag schema, executable script, or repo-native automation command. NOT FOR creating skills (use CreateSkill).",
  CreateSkill: "Create, validate, canonicalize, test, improve, and optimize PAI skills. USE WHEN creating a new skill, fixing skill structure, shortening descriptions, validating SKILL.md, improving trigger accuracy, or testing whether a skill works.",
  Daemon: "Manage the public daemon profile and static site that summarizes current work, interests, and public-facing activity. USE WHEN updating, reading, previewing, or deploying the daemon profile or checking its public data pipeline.",
  Delegation: "Parallelize work through subagents, background agents, teams, and independent workstreams. USE WHEN three or more separable tasks exist, parallel execution would help, or a team/subagent pattern is requested. NOT FOR editing agent definitions (use Agents).",
  Evals: "Create and run evaluation harnesses, test prompts, graders, and quality comparisons. USE WHEN measuring model/task performance, building evals, comparing outputs, defining scoring rubrics, or regression-testing prompts/skills.",
  ExtractWisdom: "Extract durable lessons, principles, heuristics, quotes, and decision rules from text or transcripts. USE WHEN mining wisdom, pulling insights from books/videos/articles, distilling principles, or turning raw material into reusable knowledge.",
  Fabric: "Use Fabric patterns for text transformation, summarization, extraction, security writing, and content workflows. USE WHEN invoking Fabric-style patterns, applying named prompt patterns, summarizing, extracting recommendations, or transforming prose with a known pattern.",
  FirstPrinciples: "Break problems down to fundamentals and rebuild reasoning from constraints, mechanisms, and causes. USE WHEN asking for first-principles analysis, root assumptions, fundamentals, mechanism design, or non-conventional reasoning from basics.",
  Ideate: "Run structured ideation workflows for quick ideas, full cycles, dream/mate/steal/test modes, and concept development. USE WHEN brainstorming products, features, strategies, names, experiments, or multiple solution directions.",
  Interceptor: "Drive and inspect authenticated browser sessions through the interceptor workflow. USE WHEN automating Claude Design or other web UIs through an existing authenticated session, capturing requests, or programmatically controlling browser-backed workflows.",
  Interview: "Conduct structured interviews to elicit goals, identity, preferences, requirements, and missing context. USE WHEN interviewing the user, gathering requirements, personalizing PAI, filling TELOS/current state, or asking adaptive discovery questions.",
  ISA: "Create and maintain Ideal State Artifacts that define target outcomes, criteria, constraints, decisions, and verification. USE WHEN scaffolding an ISA, writing ideal state criteria, checking completeness, reconciling feature files, or articulating done. NOT FOR creating skills.",
  IterativeDepth: "Deepen an answer through repeated passes from surface summary to nuanced analysis. USE WHEN asking to go deeper, add layers, revisit a topic, improve rigor, or progressively refine an explanation or plan.",
  Knowledge: "Capture, retrieve, organize, and reason over durable PAI knowledge and memory artifacts. USE WHEN saving knowledge, searching memory, updating knowledge graphs, harvesting lessons, or turning observations into reusable context.",
  Loop: "Iteratively revisit and refine a target over multiple passes. USE WHEN the user asks to loop, iterate, keep improving, refine repeatedly, or run multiple improvement cycles toward an ideal state.",
  Migrate: "Move, normalize, approve, and reconcile PAI user/memory content across schemas or locations. USE WHEN migrating files, approving migration queues, converting old memory formats, or safely moving user context into shared PAI data.",
  Optimize: "Run autonomous optimization loops with metrics, benchmarks, and hill-climbing. USE WHEN optimizing performance, quality, latency, bundle size, prompts, skills, or measurable outputs through repeated experiments.",
  PAIUpgrade: "Upgrade PAI algorithms, skills, docs, and release assets using source mining and structured recommendations. USE WHEN improving PAI itself, mining reflections, finding upgrade sources, updating algorithm doctrine, or preparing release changes.",
  PrivateInvestigator: "Investigate people, companies, entities, and public footprints with careful sourcing and privacy boundaries. USE WHEN doing background research, entity investigation, due diligence, OSINT-style lookup, or reputation/context mapping. NOT FOR general topic research (use Research).",
  Prompting: "Design, critique, and improve prompts, system instructions, patterns, and prompt engineering workflows. USE WHEN writing prompts, improving instructions, creating reusable prompt patterns, debugging prompt behavior, or adapting prompting strategy.",
  RedTeam: "Stress-test systems, plans, prompts, and assumptions from an adversarial perspective. USE WHEN red teaming, finding abuse cases, testing defenses, identifying risks, or challenging a system before release.",
  Remotion: "Create video, animation, motion graphics, and Remotion-based visual sequences. USE WHEN generating videos, animated explainers, motion graphics, scripted visual scenes, or code-driven animations. NOT FOR static images (use Art).",
  Research: "Perform research and content extraction at quick, standard, extensive, or deep-investigation depth with source verification. USE WHEN researching topics, finding information, investigating claims, extracting alpha, scraping content, mapping landscapes, or competitive analysis. NOT FOR academic paper search (use ArXiv).",
  RootCauseAnalysis: "Diagnose incidents, failures, regressions, and confusing behavior by tracing causes and evidence. USE WHEN debugging root causes, analyzing incidents, explaining why something failed, or building corrective actions.",
  Sales: "Support sales messaging, discovery, positioning, objection handling, and customer-facing assets. USE WHEN writing sales copy, preparing outreach, qualifying opportunities, handling objections, or improving commercial positioning.",
  Science: "Run evidence-based investigation loops with hypotheses, experiments, observations, and conclusions. USE WHEN designing experiments, testing claims, applying scientific method, evaluating evidence, or structuring systematic inquiry.",
  SystemsThinking: "Analyze systems through feedback loops, incentives, constraints, stocks/flows, leverage points, and second-order effects. USE WHEN mapping systems, finding leverage, modeling consequences, or reasoning about complex adaptive behavior.",
  Telos: "Manage mission, goals, beliefs, values, challenges, wisdom, and ideal-state direction in PAI. USE WHEN updating TELOS, clarifying mission, aligning decisions to goals, reviewing values, or building a personal operating frame.",
  USMetrics: "Retrieve, analyze, and explain US economic, demographic, political, and public metrics. USE WHEN asking for US statistics, macro indicators, public data, dashboards, time series, or evidence-backed metric comparisons.",
  Webdesign: "Design, audit, and integrate web interfaces, UI systems, dashboards, and prototypes. USE WHEN web design, UI polish, redesigns, mockups, design systems, landing pages, dashboards, accessibility review, or design-to-code work is requested.",
  WorldThreatModel: "Track and reason about global risks, geopolitical threats, technology risk, and strategic scenarios. USE WHEN modeling world threats, updating risk views, testing geopolitical ideas, or comparing global security scenarios.",
  WriteStory: "Write, revise, and structure fiction or narrative prose with attention to plot, character, voice, and scene craft. USE WHEN writing stories, developing characters, outlining fiction, improving scenes, or generating narrative prose.",
};

function rawDescription(text: string): string | null {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^description:\s*(.*)$/m);
  return match ? match[1].trim() : null;
}

function unquote(raw: string): string {
  let text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }
  return text
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function gitHeadText(path: string): string | null {
  const repoPath = relative(process.cwd(), path).replace(/\\/g, "/");
  const result = spawnSync("git", ["show", `HEAD:${repoPath}`], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : null;
}

function cut(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;

  const prefix = normalized.slice(0, max + 1);
  let last = -1;
  for (const stop of [". ", "; ", ", ", " OR ", " and ", " "]) {
    last = Math.max(last, prefix.lastIndexOf(stop));
  }

  return (last > max * 0.6 ? prefix.slice(0, last) : prefix.slice(0, max))
    .replace(/[\s,;:.]+$/, "")
    .trim() + ".";
}

function firstSentences(text: string, max: number): string {
  const pieces = text.split(/(?<=\.)\s+/).filter(Boolean);
  let out = "";

  for (const piece of pieces) {
    const next = `${out ? `${out} ` : ""}${piece.trim()}`;
    if (next.length > max) break;
    out = next;
  }

  return out || cut(text, max);
}

function compactDescription(original: string): string {
  const normalized = original.replace(/\s+/g, " ").trim();
  const useIndex = normalized.toUpperCase().indexOf("USE WHEN");
  if (useIndex < 0) return cut(normalized, LIMIT);

  const before = normalized.slice(0, useIndex).replace(/[\s.;:]+$/, ".").trim();
  let after = normalized.slice(useIndex + "USE WHEN".length).trim().replace(/^:\s*/, "");
  let notFor = "";

  const notIndex = after.toUpperCase().indexOf("NOT FOR");
  if (notIndex >= 0) {
    notFor = after.slice(notIndex + "NOT FOR".length).trim().replace(/^:\s*/, "");
    after = after.slice(0, notIndex).trim().replace(/[\s.;:]+$/, "");
  }

  const summary = firstSentences(before, 220);
  let maxTriggers = LIMIT - summary.length - 14;
  if (notFor) maxTriggers -= 125;

  const triggers = cut(after, Math.max(260, maxTriggers));
  let description = `${summary} USE WHEN: ${triggers}`;

  if (notFor) {
    const remaining = LIMIT - description.length - " NOT FOR: ".length;
    if (remaining > 45) description += ` NOT FOR: ${cut(notFor, remaining)}`;
  }

  if (description.length > LIMIT) description = cut(description, LIMIT);
  return description.replace(/\s+/g, " ").trim();
}

const changed: string[] = [];
const overLimit: string[] = [];

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const path = join(SKILLS_DIR, entry.name, "SKILL.md");
  if (!existsSync(path)) continue;

  const current = readFileSync(path, "utf-8");
  const source = gitHeadText(path) || current;
  const sourceDescription = rawDescription(source);
  if (!sourceDescription) continue;

  const original = unquote(sourceDescription);
  const nextDescription = CURATED_DESCRIPTIONS[entry.name] || compactDescription(original);
  if (nextDescription.length > LIMIT) {
    overLimit.push(`${entry.name}:${nextDescription.length}`);
  }

  const nextLine = `description: ${JSON.stringify(nextDescription)}`;
  const nextText = current.replace(/^description:\s*.*$/m, nextLine);
  if (nextText !== current) {
    writeFileSync(path, nextText, "utf-8");
    changed.push(`${entry.name} ${original.length} -> ${nextDescription.length}`);
  }
}

for (const line of changed) console.log(line);
if (overLimit.length > 0) {
  console.error(`OVER_LIMIT ${overLimit.join(", ")}`);
  process.exit(1);
}

console.log(`CHANGED=${changed.length}`);
