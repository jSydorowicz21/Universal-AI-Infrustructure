/**
 * Canonical filesystem paths for Conduit.
 *
 * INVARIANT (constitutional): ALL Conduit DATA lives under LIFEOS/USER/ — never
 * in the system code area. This module is the single place paths are resolved so
 * that invariant is enforced in one spot. Code lives in LIFEOS/PULSE/Conduit/;
 * data lives in LIFEOS/USER/CONDUIT/.
 */
import { join } from "node:path";
import { getLifeosConfigRoot, getLifeosDir } from "../../TOOLS/lib/paths";

/** Selected configuration root. Retained as a public export for existing consumers. */
export const CLAUDE_ROOT = getLifeosConfigRoot();

/** All Conduit data lives here, under USER. Nothing Conduit writes escapes this dir. */
export const DATA_ROOT = join(getLifeosDir(), "USER", "CONDUIT");

export const EVENTS_DIR = join(DATA_ROOT, "events");
export const DAILY_DIR = join(DATA_ROOT, "daily");
/** Hourly content-type read (the cheap-inference layer). Data — lives under USER. */
export const INSIGHTS_DIR = join(DATA_ROOT, "insights");
export const CONFIG_PATH = join(DATA_ROOT, "config.json");
export const STATE_PATH = join(DATA_ROOT, "state.json");

/** Path to a given day's raw event log (append-only JSONL). */
export function eventsPathFor(date: string): string {
  return join(EVENTS_DIR, `${date}.jsonl`);
}

/** Path to a given day's insight file (the hourly content-type read). */
export function insightPathFor(date: string): string {
  return join(INSIGHTS_DIR, `${date}.json`);
}

/** Paths to a given day's rolled-up record (human markdown + machine JSON). */
export function dailyPathsFor(date: string): { md: string; json: string } {
  return { md: join(DAILY_DIR, `${date}.md`), json: join(DAILY_DIR, `${date}.json`) };
}
