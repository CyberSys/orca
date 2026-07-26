import { noteOpenCodeSqliteScanHardFailure } from './session-scanner-opencode-sqlite-scan-cooldown'

export const OPENCODE_SQLITE_SCAN_DEADLINE_MS = 45_000
export const MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS = 3
// Why: a worker that answers slowly is not a worker that died. A large DB can
// exceed the per-call timeout without anything being wrong, so timeouts get
// their own budget and their own termination reason rather than being reported
// to the user as a crash.
export const MAX_CONSECUTIVE_OPENCODE_WORKER_TIMEOUTS = 3

export class OpenCodeSqliteScanTerminatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCodeSqliteScanTerminatedError'
  }
}

export function isOpenCodeSqliteScanTerminatedError(
  error: unknown
): error is OpenCodeSqliteScanTerminatedError {
  return error instanceof OpenCodeSqliteScanTerminatedError
}

export type OpenCodeSqliteScanTerminationReason =
  | 'cooldown'
  | 'deadline'
  | 'workerCrashLoop'
  | 'workerTimeoutLoop'
  | 'scanEnded'

export type OpenCodeSqliteScanMetrics = {
  activeWorkerMs: number
  deadlineExpired: boolean
  queueWaitMs: number
  sqliteListCancelled: boolean
  terminationReason: OpenCodeSqliteScanTerminationReason | null
  workOmitted: boolean
}

export class OpenCodeSqliteScanContext {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private deadlineTimer: NodeJS.Timeout | null = null
  // Budget left to spend; only decremented while the deadline is armed.
  private remainingDeadlineMs: number
  private armedAtMs: number | null = null
  private armCount = 0
  private deadlineRetired = false
  private consecutiveWorkerDeaths = 0
  private consecutiveWorkerTimeouts = 0
  private activeWorkerMs = 0
  private queueWaitMs = 0
  private deadlineExpired = false
  private listCancelled = false
  private omitted = false
  private terminationReason: OpenCodeSqliteScanTerminationReason | null = null

  constructor(deadlineMs = OPENCODE_SQLITE_SCAN_DEADLINE_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
      throw new RangeError('OpenCode SQLite scan deadline must be a non-negative integer')
    }
    this.remainingDeadlineMs = deadlineMs
    this.signal = this.controller.signal
  }

  get isTerminated(): boolean {
    return this.signal.aborted
  }

  markWorkOmitted(): void {
    this.omitted = true
  }

  // A cancelled list leaves legacy OpenCode files unreconciled against SQLite.
  markSqliteListCancelled(): void {
    this.listCancelled = true
  }

  terminationError(): OpenCodeSqliteScanTerminatedError {
    return isOpenCodeSqliteScanTerminatedError(this.signal.reason)
      ? this.signal.reason
      : new OpenCodeSqliteScanTerminatedError('OpenCode SQLite scan was cancelled')
  }

  noteWorkerResponse(): void {
    this.consecutiveWorkerDeaths = 0
    this.consecutiveWorkerTimeouts = 0
  }

  noteWorkerDeath(): boolean {
    this.consecutiveWorkerDeaths += 1
    return this.consecutiveWorkerDeaths >= MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS
  }

  noteWorkerTimeout(): boolean {
    this.consecutiveWorkerTimeouts += 1
    return this.consecutiveWorkerTimeouts >= MAX_CONSECUTIVE_OPENCODE_WORKER_TIMEOUTS
  }

  tripCircuit(error: Error): void {
    noteOpenCodeSqliteScanHardFailure()
    this.abort(
      `OpenCode SQLite worker crashed repeatedly; remaining work was skipped (${error.message})`,
      'workerCrashLoop'
    )
  }

  tripTimeoutCircuit(error: Error): void {
    noteOpenCodeSqliteScanHardFailure()
    this.abort(
      `OpenCode SQLite worker kept timing out; remaining work was skipped (${error.message})`,
      'workerTimeoutLoop'
    )
  }

  /** Skip this scan's SQLite work entirely while the process-wide backoff holds. */
  enterCooldown(remainingMs: number): void {
    this.abort(
      `OpenCode SQLite scanning is paused for another ${Math.ceil(remainingMs / 1000)}s after repeated failures`,
      'cooldown'
    )
  }

  noteQueueWait(durationMs: number): void {
    this.queueWaitMs += Math.max(0, durationMs)
  }

  noteActiveWorker(durationMs: number): void {
    this.activeWorkerMs += Math.max(0, durationMs)
  }

  metrics(): OpenCodeSqliteScanMetrics {
    return {
      activeWorkerMs: this.activeWorkerMs,
      deadlineExpired: this.deadlineExpired,
      queueWaitMs: this.queueWaitMs,
      sqliteListCancelled: this.listCancelled,
      terminationReason: this.terminationReason,
      workOmitted: this.omitted
    }
  }

  /**
   * Start (or re-start) the budget clock for one leg of SQLite work. Arming is
   * reference counted so overlapping list/parse legs share one clock, and the
   * budget only elapses while SQLite work is actually outstanding — a slow cache
   * load or another agent's transcripts must never spend OpenCode's budget.
   */
  armDeadline(): void {
    this.armCount += 1
    if (this.armCount > 1 || this.deadlineRetired || this.signal.aborted || this.deadlineTimer) {
      return
    }
    this.armedAtMs = Date.now()
    this.deadlineTimer = setTimeout(() => {
      this.deadlineExpired = true
      this.abort('OpenCode SQLite scan deadline elapsed', 'deadline')
    }, this.remainingDeadlineMs)
    this.deadlineTimer.unref?.()
  }

  /** Stop the clock once the last outstanding SQLite leg settles, banking what is left. */
  pauseDeadline(): void {
    if (this.armCount === 0) {
      return
    }
    this.armCount -= 1
    if (this.armCount === 0) {
      this.stopDeadlineTimer()
    }
  }

  /** Retire the budget for the rest of the scan; no later leg can re-arm it. */
  disarmDeadline(): void {
    this.armCount = 0
    this.deadlineRetired = true
    this.stopDeadlineTimer()
  }

  dispose(): void {
    this.abort('OpenCode SQLite scan ended', 'scanEnded')
  }

  private stopDeadlineTimer(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
    if (this.armedAtMs !== null) {
      this.remainingDeadlineMs = Math.max(
        0,
        this.remainingDeadlineMs - (Date.now() - this.armedAtMs)
      )
      this.armedAtMs = null
    }
  }

  private abort(message: string, reason: OpenCodeSqliteScanTerminationReason): void {
    this.disarmDeadline()
    if (!this.signal.aborted) {
      this.terminationReason = reason
      this.controller.abort(new OpenCodeSqliteScanTerminatedError(message))
    }
  }
}
