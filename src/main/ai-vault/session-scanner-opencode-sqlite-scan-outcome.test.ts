import { describe, expect, it, vi } from 'vitest'
import type { ActiveSpan } from '../observability/tracer'
import { recordOpenCodeSqliteScanOutcome } from './session-scanner-opencode-sqlite-scan-outcome'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'

function recordingSpan(attributes: Map<string, unknown>): ActiveSpan {
  return {
    traceId: 'trace',
    spanId: 'span',
    setAttribute(key, value) {
      attributes.set(key, value)
    },
    addEvent() {},
    fail() {},
    interrupt() {},
    end() {}
  }
}

describe('recordOpenCodeSqliteScanOutcome', () => {
  it('reports omitted work once with tuning metrics', () => {
    const context = new OpenCodeSqliteScanContext()
    const attributes = new Map<string, unknown>()
    const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
    try {
      context.markWorkOmitted()
      context.markWorkOmitted()
      context.noteQueueWait(12)
      context.noteActiveWorker(34)

      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(attributes)
      })

      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/Some OpenCode history was skipped/)
      expect(attributes.get('opencodeSqliteQueueWaitMs')).toBe(12)
      expect(attributes.get('opencodeSqliteActiveWorkerMs')).toBe(34)
    } finally {
      context.dispose()
    }
  })

  it('does not report deadline expiry when no work was omitted', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      await vi.advanceTimersByTimeAsync(1)
      const issues: Parameters<typeof recordOpenCodeSqliteScanOutcome>[0]['issues'] = []
      recordOpenCodeSqliteScanOutcome({
        candidates: [],
        context,
        discoveries: [],
        issues,
        span: recordingSpan(new Map())
      })
      expect(context.metrics().deadlineExpired).toBe(true)
      expect(issues).toEqual([])
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('disarms the deadline before later non-SQLite scan work', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      context.disarmDeadline()
      await vi.advanceTimersByTimeAsync(10)
      expect(context.isTerminated).toBe(false)
      expect(context.metrics().deadlineExpired).toBe(false)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })
})
