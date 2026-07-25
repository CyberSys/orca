import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRendererMemoryProfileCounts } from '@/lib/renderer-memory-profile'
import { registerPtySideEffectPendingGauge } from './pty-side-effect-pending-census'

function ptySideEffectCounts(): { pending: number; processors: number } {
  const counts = collectRendererMemoryProfileCounts()
  return {
    pending: counts['ptySideEffects.pending'],
    processors: counts['ptySideEffects.processors']
  }
}

describe('pty side-effect pending census', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sums registered gauges and drops disposed ones', () => {
    const before = ptySideEffectCounts()
    const disposeA = registerPtySideEffectPendingGauge(() => 3)
    const disposeB = registerPtySideEffectPendingGauge(() => 4)

    let counts = ptySideEffectCounts()
    expect(counts.pending).toBe(before.pending + 7)
    expect(counts.processors).toBe(before.processors + 2)

    disposeA()
    counts = ptySideEffectCounts()
    expect(counts.pending).toBe(before.pending + 4)
    expect(counts.processors).toBe(before.processors + 1)

    disposeB()
    expect(ptySideEffectCounts()).toEqual(before)
  })

  it('tracks a live output processor queue through enqueue, drain, and dispose', async () => {
    vi.useFakeTimers()
    const { createPtyOutputProcessor } = await import('./pty-transport')
    const before = ptySideEffectCounts()
    const processor = createPtyOutputProcessor({ onTitleChange: vi.fn() })

    expect(ptySideEffectCounts()).toEqual({
      pending: before.pending,
      processors: before.processors + 1
    })

    processor.processData('\x1b]0;census-title\x07', { onData: vi.fn() })
    expect(ptySideEffectCounts().pending).toBe(before.pending + 1)

    await vi.runOnlyPendingTimersAsync()
    expect(ptySideEffectCounts().pending).toBe(before.pending)

    processor.processData('\x1b]0;census-title-2\x07', { onData: vi.fn() })
    expect(ptySideEffectCounts().pending).toBe(before.pending + 1)
    processor.clearAccumulatedState()
    expect(ptySideEffectCounts().pending).toBe(before.pending)

    processor.disposePendingSideEffectGauge()
    expect(ptySideEffectCounts()).toEqual(before)
  })
})
