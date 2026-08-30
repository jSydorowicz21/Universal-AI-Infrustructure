type TomlValue = string | number | boolean | TomlValue[] | Record<string, unknown>

function stripComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") {
      quote = quote === ch ? null : quote ?? ch
    }
    if (ch === "#" && !quote) return line.slice(0, i)
  }
  return line
}

function parseScalar(raw: string): TomlValue {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(",").map((part) => parseScalar(part.trim()))
  }
  const numberValue = Number(value)
  if (Number.isFinite(numberValue) && /^-?\d+(\.\d+)?$/.test(value)) return numberValue
  return value
}

function setValue(target: Record<string, unknown>, key: string, value: TomlValue): void {
  const parts = key.split(".").map((part) => part.trim()).filter(Boolean)
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] ?? key] = value
}

export function parseToml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let current: Record<string, unknown> = root

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    const arrayTable = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/)
    if (arrayTable) {
      const key = arrayTable[1]
      const existing = root[key]
      const next: Record<string, unknown> = {}
      if (Array.isArray(existing)) {
        existing.push(next)
      } else {
        root[key] = [next]
      }
      current = next
      continue
    }

    const table = line.match(/^\[([A-Za-z0-9_.-]+)\]$/)
    if (table) {
      const parts = table[1].split(".")
      current = root
      for (const part of parts) {
        if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
          current[part] = {}
        }
        current = current[part] as Record<string, unknown>
      }
      continue
    }

    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = parseScalar(line.slice(eq + 1))
    setValue(current, key, value)
  }

  return root
}
