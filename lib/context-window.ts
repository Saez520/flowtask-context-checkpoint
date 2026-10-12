export interface TokenUsage { input: number; cache: { read: number; write: number } }
export interface WindowReading { tokens?: number; reason?: string }

export function readContextWindow(usage: TokenUsage | undefined): WindowReading {
  if (!usage || !usage.cache) return { reason: "missing-token-data" }
  const values: number[] = [usage.input, usage.cache.read, usage.cache.write]
  if (!values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return { reason: "invalid-token-data" }
  }
  return { tokens: values.reduce((sum, value) => sum + value, 0) }
}

export interface ModelReference { providerID: string; id: string; variant?: string }
export interface ModelWithLimit { providerID: string; id: string; variant?: string; limit?: { context?: number } }

export function findContextLimit(models: readonly ModelWithLimit[], reference: ModelReference): number | undefined {
  const model = models.find(candidate => candidate.providerID === reference.providerID
    && candidate.id === reference.id && candidate.variant === reference.variant)
  const limit = model?.limit?.context
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
}
