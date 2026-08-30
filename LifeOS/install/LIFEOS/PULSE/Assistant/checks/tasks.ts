#!/usr/bin/env bun
import { existsSync, readFileSync } from "fs"
import { memoryPath } from "../../../TOOLS/lib/paths"

const statePath = memoryPath("STATE", "pulse", "assistant.json")

try {
  if (!existsSync(statePath)) {
    console.log("NO_ACTION")
    process.exit(0)
  }
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  const active = Array.isArray(state.tasks)
    ? state.tasks.filter((task: any) => task?.status === "active").length
    : 0
  console.log(active > 0 ? `Assistant has ${active} active task(s).` : "NO_ACTION")
} catch {
  console.log("NO_ACTION")
}
