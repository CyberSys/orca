import type { Worker } from 'node:worker_threads'
import type {
  OpenCodeSqliteListRequest,
  OpenCodeSqliteParseRequest,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { errorMessage } from './session-scanner-values'
import {
  MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS,
  type OpenCodeSqliteScanContext
} from './session-scanner-opencode-sqlite-scan-context'

// Why (#8864): a lazily-spawned, unref'd worker runs OpenCode SQLite reads off
// the main-process event loop. Lifecycle (idle teardown, FIFO one-at-a-time
// dispatch, per-call timeouts, respawn-on-fault) mirrors src/main/speech/
// stt-service.ts. The default spawn + shared singleton live in
// session-scanner-opencode-sqlite-worker-spawn.ts.

export const IDLE_TEARDOWN_MS = 30_000
// Why: scan-owned fault state survives queue-empty batch gaps without affecting
// overlapping scans.
export const MAX_CONSECUTIVE_DEATHS = MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS

export type WorkerFactory = () => Worker

// Omit<union, 'id'> collapses to the shared keys, so omit each member and let
// the client stamp the correlation id.
type OpenCodeSqliteRequestBody =
  | Omit<OpenCodeSqliteListRequest, 'id'>
  | Omit<OpenCodeSqliteParseRequest, 'id'>

type PendingCall = {
  request: OpenCodeSqliteWorkerRequest
  context: OpenCodeSqliteScanContext
  enqueuedAtMs: number
  queueWaitRecorded: boolean
  activeAtMs: number | null
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

// Distinguishes "no worker available at all" from a timeout or crash so callers
// can surface a precise issue while keeping synchronous SQLite off the main thread.
export class OpenCodeSqliteWorkerUnavailableError extends Error {}

/**
 * Worker transport that runs OpenCode SQLite reads on a persistent worker
 * thread. Dispatches one request at a time (FIFO), times each request out from
 * dispatch, respawns after faults (capped by `MAX_CONSECUTIVE_DEATHS`), tears
 * the worker down after `IDLE_TEARDOWN_MS` of inactivity, and fails closed when
 * no worker can be spawned rather than moving SQLite work onto the main thread.
 */
export class OpenCodeSqliteWorkerTransport {
  private worker: Worker | null = null
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private loggedWorkerUnavailable = false
  private cleanupWorkerListeners: (() => void) | null = null
  private readonly contextAbortListeners = new Map<OpenCodeSqliteScanContext, () => void>()
  private readonly workerFactory: WorkerFactory
  private readonly log: (message: string) => void

  constructor(options: { workerFactory: WorkerFactory; log?: (message: string) => void }) {
    this.workerFactory = options.workerFactory
    this.log = options.log ?? ((message) => console.warn(message))
  }

  dispatch(
    request: OpenCodeSqliteRequestBody,
    timeoutMs: number,
    context: OpenCodeSqliteScanContext
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (context.isTerminated) {
        context.markWorkOmitted()
        reject(context.terminationError())
        return
      }
      const id = this.nextId++
      this.queue.push({
        request: { ...request, id } as OpenCodeSqliteWorkerRequest,
        context,
        enqueuedAtMs: Date.now(),
        queueWaitRecorded: false,
        activeAtMs: null,
        timeoutMs,
        resolve,
        reject,
        timer: null
      })
      this.ensureContextAbortListener(context)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    const worker = this.ensureWorker()
    if (!worker) {
      this.failQueuedAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.clearIdleTimer()
    call.activeAtMs = Date.now()
    this.recordQueueWait(call, call.activeAtMs)
    // Timeout clock starts at dispatch (not enqueue): a batch may enqueue up to
    // 8 parses at once, and a queue-inclusive timeout would fire falsely.
    call.timer = setTimeout(() => this.onTimeout(call), call.timeoutMs)
    call.timer.unref?.()
    try {
      worker.postMessage(call.request)
    } catch (err) {
      this.onWorkerFault(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.workerFactory()
      const onMessage = (response: OpenCodeSqliteWorkerResponse): void => this.onMessage(response)
      const onError = (error: Error): void => this.onWorkerFault(error)
      const onExit = (code: number): void => this.onWorkerExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupWorkerListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      // Never keep the app alive for a scan worker.
      worker.unref?.()
      this.worker = worker
      return worker
    } catch (err) {
      // Why (#8864): never fall back to synchronous SQLite reads here; a missing
      // bundle or resource-exhausted spawn must omit OpenCode history rather than
      // reintroduce the main-process hang this worker boundary prevents.
      if (!this.loggedWorkerUnavailable) {
        this.loggedWorkerUnavailable = true
        this.log(`OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`)
      }
      return null
    }
  }

  private onMessage(response: OpenCodeSqliteWorkerResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    call.context.noteWorkerResponse()
    if (response.ok) {
      this.settle(call, () => call.resolve(response.value))
    } else {
      this.settle(call, () => call.reject(new Error(response.error)))
    }
    this.releaseContextAbortListenerIfUnused(call.context)
    this.afterSettle()
  }

  private onTimeout(call: PendingCall): void {
    if (this.active !== call) {
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker timed out after ${call.timeoutMs}ms`))
  }

  private onWorkerExit(code: number): void {
    // A clean self-exit is not a death, but the stale handle must be dropped
    // or the next dispatch would post into the dead worker and stall to timeout.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.destroyWorker()
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker exited with code ${code}`))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.destroyWorker()
    const shouldTrip = failed?.context.noteWorkerDeath() ?? false
    if (failed) {
      this.settle(failed, () => failed.reject(error))
    }
    if (failed && shouldTrip) {
      failed.context.tripCircuit(error)
      return
    }
    if (failed) {
      this.releaseContextAbortListenerIfUnused(failed.context)
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () =>
        call.reject(new OpenCodeSqliteWorkerUnavailableError('worker spawn failed'))
      )
    }
    for (const call of pending) {
      this.releaseContextAbortListenerIfUnused(call.context)
    }
  }

  private settle(call: PendingCall, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (call.activeAtMs !== null) {
      call.context.noteActiveWorker(Date.now() - call.activeAtMs)
      call.activeAtMs = null
    }
    if (this.active === call) {
      this.active = null
    }
    run()
  }

  private ensureContextAbortListener(context: OpenCodeSqliteScanContext): void {
    if (this.contextAbortListeners.has(context)) {
      return
    }
    const onAbort = (): void => this.onContextAbort(context)
    this.contextAbortListeners.set(context, onAbort)
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (context.signal.aborted) {
      this.onContextAbort(context)
    }
  }

  private onContextAbort(context: OpenCodeSqliteScanContext): void {
    const error = context.terminationError()
    if (this.active?.context === context) {
      const active = this.active
      this.destroyWorker()
      context.markWorkOmitted()
      this.settle(active, () => active.reject(error))
    }
    const retained: PendingCall[] = []
    for (const call of this.queue) {
      if (call.context === context) {
        context.markWorkOmitted()
        this.recordQueueWait(call, Date.now())
        this.settle(call, () => call.reject(error))
      } else {
        retained.push(call)
      }
    }
    this.queue = retained
    this.releaseContextAbortListener(context)
    if (!this.active && this.queue.length > 0) {
      this.pump()
    }
  }

  private releaseContextAbortListenerIfUnused(context: OpenCodeSqliteScanContext): void {
    if (this.active?.context !== context && !this.queue.some((call) => call.context === context)) {
      this.releaseContextAbortListener(context)
    }
  }

  private recordQueueWait(call: PendingCall, settledAtMs: number): void {
    if (call.queueWaitRecorded) {
      return
    }
    call.queueWaitRecorded = true
    call.context.noteQueueWait(settledAtMs - call.enqueuedAtMs)
  }

  private releaseContextAbortListener(context: OpenCodeSqliteScanContext): void {
    const listener = this.contextAbortListeners.get(context)
    if (!listener) {
      return
    }
    context.signal.removeEventListener('abort', listener)
    this.contextAbortListeners.delete(context)
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
    } else {
      this.scheduleIdleTeardown()
    }
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => this.teardownIfIdle(), IDLE_TEARDOWN_MS)
    this.idleTimer.unref?.()
  }

  private teardownIfIdle(): void {
    this.idleTimer = null
    // Only tear down with nothing active AND nothing queued: a request arriving
    // as the timer fires must never be lost to a self-exiting worker.
    if (this.active || this.queue.length > 0) {
      return
    }
    this.destroyWorker()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private destroyWorker(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    this.cleanupWorkerListeners?.()
    this.cleanupWorkerListeners = null
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }
}
