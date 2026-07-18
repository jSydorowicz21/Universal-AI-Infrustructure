#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"
import { memoryPath } from "../../../TOOLS/lib/paths"

const statePath = memoryPath("STATE", "pulse", "assistant.json")

function readState(): Record<string, unknown> {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : {}
  } catch {
    return {}
  }
}

const state = readState()
state.lastHeartbeat = new Date().toISOString()
mkdirSync(dirname(statePath), { recursive: true })
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8")
console.log("HEARTBEAT_OK")
