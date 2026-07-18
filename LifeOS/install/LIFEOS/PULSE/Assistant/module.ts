import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { getFrameworkDir, memoryPath, userPath } from "../../TOOLS/lib/paths"

type PulseJob = {
  name: string
  schedule: string
  enabled: boolean
  type?: string
  output?: string | string[]
}

type AssistantTask = {
  id: string
  name: string
  schedule: string
  status: "active" | "disabled" | "completed" | "cancelled"
  source: "da"
  details?: Record<string, unknown>
}

type AssistantState = {
  startedAt: number
  config: Record<string, unknown>
  jobs: PulseJob[]
  tasks: AssistantTask[]
  traits: Record<string, number>
  lastHeartbeat: string | null
}

const STATE_PATH = memoryPath("STATE", "pulse", "assistant.json")
const DIARY_DIR = memoryPath("RELATIONSHIP", "assistant-diary")
let state: AssistantState = {
  startedAt: 0,
  config: {},
  jobs: [],
  tasks: [],
  traits: {},
  lastHeartbeat: null,
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  ensureParent(path)
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8")
}

function settings(): Record<string, any> {
  return readJson<Record<string, any>>(join(getFrameworkDir(), "settings.json"), {})
}

function identity() {
  const s = settings()
  const da = s.daidentity ?? {}
  const principal = s.principal ?? {}
  const name = da.name || da.displayName || "PAI"
  return {
    name,
    full_name: da.fullName || `${name} - Personal AI`,
    display_name: da.displayName || String(name).toUpperCase(),
    color: da.color || "#3B82F6",
    role: "Digital Assistant",
    origin_story: "PAI Digital Assistant runtime identity.",
    has_avatar: false,
    principal: principal.name || "User",
    uptime_ms: Date.now() - state.startedAt,
  }
}

function personality() {
  return {
    base_description: "A practical digital assistant focused on the principal's Life OS.",
    traits: {
      clarity: 80,
      initiative: 65,
      discretion: 90,
      rigor: 80,
      warmth: 65,
      ...state.traits,
    },
    anchors: [
      { name: "Life OS", description: "Keep current work connected to durable user context." },
      { name: "Momentum", description: "Prefer reversible progress over unnecessary waiting." },
    ],
    preferences: {
      what_i_love: ["clear goals", "well-maintained context", "working systems"],
      what_i_dislike: ["stale state", "fragile automation"],
      working_style: ["direct", "evidence-driven", "low-friction"],
      intellectual_interests: ["personal AI infrastructure", "automation", "memory systems"],
    },
    companion: null,
    relationship: {
      dynamic: "principal and digital assistant",
      interaction_style: "concise, useful, and grounded in PAI context",
    },
    autonomy: {
      can_initiate: ["surface stale tasks", "summarize runtime health"],
      must_ask: ["irreversible external actions", "credential changes"],
    },
    writing: {
      style: "plain, direct, and specific",
      avoid: ["empty reassurance", "unverified claims"],
      prefer: ["concrete next actions", "evidence"],
    },
    voice: null,
  }
}

function loadState(): void {
  const saved = readJson<Partial<AssistantState>>(STATE_PATH, {})
  state = {
    ...state,
    ...saved,
    startedAt: Date.now(),
    tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
    traits: saved.traits && typeof saved.traits === "object" ? saved.traits : {},
    lastHeartbeat: typeof saved.lastHeartbeat === "string" ? saved.lastHeartbeat : null,
  }
}

function saveState(): void {
  writeJson(STATE_PATH, {
    ...state,
    startedAt: Date.now(),
  })
}

function pulseTasks() {
  return state.jobs.map((job) => ({
    name: job.name,
    schedule: job.schedule,
    status: job.enabled ? "active" : "disabled",
    source: "pulse" as const,
    details: { type: job.type ?? "script", output: job.output ?? "log" },
  }))
}

function diaryEntries() {
  try {
    if (!existsSync(DIARY_DIR)) return []
    return readdirSync(DIARY_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(-30)
      .map((name) => readJson(join(DIARY_DIR, name), null))
      .filter(Boolean)
      .reverse()
  } catch {
    return []
  }
}

function responseJson(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}

async function requestJson(req: Request): Promise<Record<string, any>> {
  try {
    return await req.json() as Record<string, any>
  } catch {
    return {}
  }
}

export function startAssistant(config: Record<string, unknown> = {}, jobs: PulseJob[] = []): void {
  loadState()
  state.config = config
  state.jobs = jobs
  saveState()
}

export function assistantHealth() {
  const id = identity()
  const opinionsPath = userPath("OPINIONS.md")
  return {
    status: "ok",
    primary_da: String(state.config.primary || id.name || "PAI"),
    identity_loaded: Boolean(id.name),
    scheduled_tasks: state.tasks.filter((task) => task.status === "active").length,
    last_heartbeat: state.lastHeartbeat,
    diary_entries_today: 0,
    opinions_count: existsSync(opinionsPath) ? 1 : 0,
  }
}

export async function handleAssistantRequest(req: Request, pathname: string): Promise<Response | null> {
  const method = req.method.toUpperCase()

  if (method === "GET" && pathname === "/assistant/health") return responseJson(assistantHealth())
  if (method === "GET" && pathname === "/assistant/identity") return responseJson(identity())
  if (method === "GET" && pathname === "/assistant/personality") return responseJson(personality())
  if (method === "GET" && pathname === "/assistant/diary") return responseJson({ entries: diaryEntries() })
  if (method === "GET" && pathname === "/assistant/opinions") {
    const path = userPath("OPINIONS.md")
    return responseJson({ raw: existsSync(path) ? readFileSync(path, "utf-8") : "" })
  }
  if (method === "GET" && pathname === "/assistant/tasks") {
    const tasks = [...state.tasks, ...pulseTasks()]
    return responseJson({
      tasks,
      count: tasks.length,
      by_source: {
        da: state.tasks.length,
        pulse: state.jobs.length,
        "claude-code": 0,
      },
    })
  }
  if (method === "GET" && pathname === "/assistant/avatar") {
    const id = identity()
    const initial = String(id.display_name || id.name || "P").slice(0, 1).toUpperCase()
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${id.color}"/><text x="64" y="78" text-anchor="middle" font-size="56" fill="white" font-family="Arial, sans-serif">${initial}</text></svg>`,
      { headers: { "Content-Type": "image/svg+xml" } },
    )
  }
  if (method === "PATCH" && pathname === "/assistant/personality/traits") {
    const body = await requestJson(req)
    for (const [key, value] of Object.entries(body)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) state.traits[key] = Math.max(0, Math.min(100, Math.round(numeric)))
    }
    saveState()
    return responseJson(personality())
  }
  if (method === "POST" && pathname === "/assistant/tasks") {
    const body = await requestJson(req)
    const description = String(body.description || body.action?.message || "Assistant task")
    const task: AssistantTask = {
      id: randomUUID(),
      name: description,
      schedule: String(body.schedule?.cron || body.schedule || "manual"),
      status: "active",
      source: "da",
      details: body,
    }
    state.tasks.push(task)
    saveState()
    return responseJson(task, { status: 201 })
  }
  const deleteMatch = pathname.match(/^\/assistant\/tasks\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const task = state.tasks.find((candidate) => candidate.id === deleteMatch[1])
    if (!task) return responseJson({ error: "Task not found" }, { status: 404 })
    task.status = "cancelled"
    saveState()
    return responseJson(task)
  }

  return null
}
