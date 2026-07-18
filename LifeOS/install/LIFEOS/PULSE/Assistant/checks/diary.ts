#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { memoryPath } from "../../../TOOLS/lib/paths"

const now = new Date()
const day = now.toISOString().slice(0, 10)
const dir = memoryPath("RELATIONSHIP", "assistant-diary")
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${day}.json`), JSON.stringify({
  date: day,
  updated_at: now.toISOString(),
  interaction_count: 0,
  topics: [],
  mood: "neutral",
  avg_rating: 0,
  notable_moments: [],
  learning: null,
}, null, 2) + "\n", "utf-8")
console.log("NO_ACTION")
