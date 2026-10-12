import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
export interface WindowReading { tokens: number; reason?: string }
export function readContextWindow(sessionID: string, databasePath = join(homedir(), ".local/share/opencode/opencode.db")): WindowReading {
  let db: Database | undefined
  try {
    db = new Database(databasePath, { readonly: true })
    if (!db.query("SELECT id FROM session_v2 WHERE id = ?").get(sessionID)) return { tokens: 0, reason: "session-not-found" }
    const row = db.query("SELECT data FROM session_message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.time.completed') IS NOT NULL ORDER BY time_created DESC LIMIT 1").get(sessionID) as { data: string } | undefined
    if (!row) return { tokens: 0, reason: "assistant-message-not-found" }
    const msg = JSON.parse(row.data) as { tokens?: Record<string, unknown> }
    const t = msg.tokens, cache = t?.cache as Record<string, unknown> | undefined
    const values = [t?.input, t?.output, t?.reasoning, cache?.read]
    if (!values.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) return { tokens: 0, reason: "invalid-token-data" }
    return { tokens: values.reduce<number>((sum, v) => sum + (v as number), 0) }
  } catch { return { tokens: 0, reason: "database-or-json-error" } }
  finally { db?.close() }
}
