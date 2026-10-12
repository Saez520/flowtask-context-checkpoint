export function checkpointInstruction(tokens: number, limit: number, ratio: number): string {
  const pct = Math.round(ratio * 100)
  return ["[FLOWTASK_CONTEXT_ALERT]", `El contexto está al ${pct}% (${tokens} / ${limit} tokens).`, "Carga checkpoint-mixin y guarda el estado actual en Engram siguiendo su contrato vigente.", `Incluye exactamente este tag en la respuesta: [FLOWTASK_CHECKPOINT_CAPACITY: ${pct}%]`].join("\n")
}
