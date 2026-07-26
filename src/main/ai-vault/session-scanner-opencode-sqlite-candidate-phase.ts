import { looksLikeOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import type { SessionFileCandidate } from './session-scanner-types'

export class OpenCodeSqliteCandidatePhase {
  private remainingCandidates: number

  constructor(
    candidates: readonly SessionFileCandidate[],
    private readonly context?: OpenCodeSqliteScanContext
  ) {
    this.remainingCandidates = context
      ? candidates.filter((candidate) => looksLikeOpenCodeSqliteCandidate(candidate.file.path))
          .length
      : 0
    if (this.remainingCandidates === 0) {
      context?.disarmDeadline()
    }
  }

  prepareBatch(batch: readonly SessionFileCandidate[]): SessionFileCandidate[] {
    return batch.filter((candidate) => {
      if (!looksLikeOpenCodeSqliteCandidate(candidate.file.path)) {
        return true
      }
      this.remainingCandidates -= 1
      if (!this.context?.isTerminated) {
        return true
      }
      this.context.markWorkOmitted()
      return false
    })
  }

  trackBatch(
    candidates: readonly SessionFileCandidate[],
    promises: readonly Promise<unknown>[]
  ): void {
    if (this.remainingCandidates !== 0 || !this.context) {
      return
    }
    const sqlitePromises = promises.filter((_, index) =>
      looksLikeOpenCodeSqliteCandidate(candidates[index]?.file.path ?? '')
    )
    if (sqlitePromises.length === 0) {
      return
    }
    void Promise.allSettled(sqlitePromises).then(() => this.context?.disarmDeadline())
  }

  finish(): void {
    this.context?.disarmDeadline()
  }
}
