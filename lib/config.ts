export interface CheckpointOptions { enabled: boolean; checkpointThreshold: number; assumedContextLimit: number }
export const DEFAULT_OPTIONS: CheckpointOptions = { enabled: true, checkpointThreshold: 0.7, assumedContextLimit: 128000 }
export function parseOptions(raw: Record<string, unknown>, warn: (key: string) => void): CheckpointOptions {
  let enabled = true
  if (raw.enabled !== undefined) { if (typeof raw.enabled === "boolean") enabled = raw.enabled; else warn("enabled") }
  let checkpointThreshold = 0.7
  if (raw.checkpointThreshold !== undefined) { if (typeof raw.checkpointThreshold === "number" && raw.checkpointThreshold > 0 && raw.checkpointThreshold <= 1) checkpointThreshold = raw.checkpointThreshold; else warn("checkpointThreshold") }
  let assumedContextLimit = 128000
  if (raw.assumedContextLimit !== undefined) { if (typeof raw.assumedContextLimit === "number" && Number.isInteger(raw.assumedContextLimit) && raw.assumedContextLimit > 0) assumedContextLimit = raw.assumedContextLimit; else warn("assumedContextLimit") }
  return { enabled, checkpointThreshold, assumedContextLimit }
}
