import { describe, expect, it, vi } from 'vitest'
import { OpenCodeSqliteCandidatePhase } from './session-scanner-opencode-sqlite-candidate-phase'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import type { SessionFileCandidate } from './session-scanner-types'

function candidate(path: string): SessionFileCandidate {
  return {
    agent: 'opencode',
    codexHome: null,
    file: { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
  }
}

describe('OpenCodeSqliteCandidatePhase', () => {
  it('filters terminated SQLite candidates before parsing but keeps legacy files', () => {
    const context = new OpenCodeSqliteScanContext()
    const sqlite = candidate('/data/opencode.db#session')
    const legacy = candidate('/data/storage/session/session.json')
    try {
      context.tripCircuit(new Error('test circuit'))
      const phase = new OpenCodeSqliteCandidatePhase([sqlite, legacy], context)

      expect(phase.prepareBatch([sqlite, legacy])).toEqual([legacy])
      expect(context.metrics().workOmitted).toBe(true)
    } finally {
      context.dispose()
    }
  })

  it('disarms immediately when discovery has no SQLite candidates', async () => {
    vi.useFakeTimers()
    const context = new OpenCodeSqliteScanContext(1)
    try {
      new OpenCodeSqliteCandidatePhase([candidate('/legacy/session.json')], context)
      await vi.advanceTimersByTimeAsync(10)
      expect(context.metrics().deadlineExpired).toBe(false)
    } finally {
      context.dispose()
      vi.useRealTimers()
    }
  })

  it('disarms after the last SQLite batch or an early parser stop', async () => {
    vi.useFakeTimers()
    const sqlite = candidate('/data/opencode.db#session')
    const completedContext = new OpenCodeSqliteScanContext(1)
    const stoppedContext = new OpenCodeSqliteScanContext(1)
    try {
      const completed = new OpenCodeSqliteCandidatePhase([sqlite], completedContext)
      expect(completed.prepareBatch([sqlite])).toEqual([sqlite])
      completed.completeBatch()

      const stopped = new OpenCodeSqliteCandidatePhase([sqlite], stoppedContext)
      stopped.finish()
      await vi.advanceTimersByTimeAsync(10)
      expect(completedContext.metrics().deadlineExpired).toBe(false)
      expect(stoppedContext.metrics().deadlineExpired).toBe(false)
    } finally {
      completedContext.dispose()
      stoppedContext.dispose()
      vi.useRealTimers()
    }
  })
})
