export const OPENCODE_SQLITE_SCAN_DEADLINE_MS = 45_000
export const MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS = 3

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

export type OpenCodeSqliteScanMetrics = {
  activeWorkerMs: number
  deadlineExpired: boolean
  queueWaitMs: number
  workOmitted: boolean
}

export class OpenCodeSqliteScanContext {
  readonly signal: AbortSignal
  readonly startedAtMs = Date.now()
  private readonly controller = new AbortController()
  private deadlineTimer: NodeJS.Timeout | null
  private consecutiveWorkerDeaths = 0
  private activeWorkerMs = 0
  private queueWaitMs = 0
  private deadlineExpired = false
  private omitted = false

  constructor(deadlineMs = OPENCODE_SQLITE_SCAN_DEADLINE_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
      throw new RangeError('OpenCode SQLite scan deadline must be a non-negative integer')
    }
    this.signal = this.controller.signal
    this.deadlineTimer = setTimeout(() => {
      this.deadlineExpired = true
      this.abort('OpenCode SQLite scan deadline elapsed')
    }, deadlineMs)
    this.deadlineTimer.unref?.()
  }

  get isTerminated(): boolean {
    return this.signal.aborted
  }

  markWorkOmitted(): void {
    this.omitted = true
  }

  terminationError(): OpenCodeSqliteScanTerminatedError {
    return isOpenCodeSqliteScanTerminatedError(this.signal.reason)
      ? this.signal.reason
      : new OpenCodeSqliteScanTerminatedError('OpenCode SQLite scan was cancelled')
  }

  noteWorkerResponse(): void {
    this.consecutiveWorkerDeaths = 0
  }

  noteWorkerDeath(): boolean {
    this.consecutiveWorkerDeaths += 1
    return this.consecutiveWorkerDeaths >= MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS
  }

  tripCircuit(error: Error): void {
    this.abort(
      `OpenCode SQLite worker crashed repeatedly; remaining work was skipped (${error.message})`
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
      workOmitted: this.omitted
    }
  }

  disarmDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }

  dispose(): void {
    this.abort('OpenCode SQLite scan ended')
  }

  private abort(message: string): void {
    this.disarmDeadline()
    if (!this.signal.aborted) {
      this.controller.abort(new OpenCodeSqliteScanTerminatedError(message))
    }
  }
}
