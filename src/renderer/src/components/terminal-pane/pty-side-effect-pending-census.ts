import { registerRendererMemoryProfileContributor } from '@/lib/renderer-memory-profile'

// Why: background timer throttling can let the uncapped queue outgrow its drain.
const pendingGauges = new Set<() => number>()

export function registerPtySideEffectPendingGauge(gauge: () => number): () => void {
  pendingGauges.add(gauge)
  return () => {
    pendingGauges.delete(gauge)
  }
}

registerRendererMemoryProfileContributor('ptySideEffects', () => {
  let pending = 0
  for (const gauge of pendingGauges) {
    pending += gauge()
  }
  return { pending, processors: pendingGauges.size }
})
