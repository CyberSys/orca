import { registerRendererMemoryProfileContributor } from '@/lib/renderer-memory-profile'

/**
 * Aggregate outstanding PTY side-effect queue depth across live output
 * processors, for renderer_memory_highwater crash profiles.
 *
 * Why: pendingSideEffects (pty-transport.ts) is the one uncapped hot-path
 * queue — drained 64/tick against a background-throttled ~1 Hz timer, and
 * pausePendingSideEffects stops the drain without clearing — so it is the C1
 * suspect the existing contributors cannot see (H2 in C1_DIAGNOSIS.md).
 */
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
