import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_TEARDOWN_MS,
  LIST_TIMEOUT_MS,
  MAX_CONSECUTIVE_DEATHS,
  OpenCodeSqliteWorkerClient,
  PARSE_TIMEOUT_MS
} from './session-scanner-opencode-sqlite-worker-client'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'

// A worker_threads stand-in the tests drive directly: it records posted requests
// and lets a test emit message/error/exit without a built worker bundle.
class FakeWorker {
  postedRequests: OpenCodeSqliteWorkerRequest[] = []
  postMessageError: Error | null = null
  terminated = false
  unrefed = false
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {
    this.unrefed = true
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: OpenCodeSqliteWorkerRequest): void {
    if (this.postMessageError) {
      const error = this.postMessageError
      this.postMessageError = null
      throw error
    }
    this.postedRequests.push(request)
  }

  emit(event: string, arg?: unknown): void {
    // Copy first: the client removes its listeners synchronously during a fault.
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  lastId(): number {
    const last = this.postedRequests.at(-1)
    if (!last) {
      throw new Error('no request posted to fake worker')
    }
    return last.id
  }
}

function makeFactory(workers: FakeWorker[]): () => Worker {
  return () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
}

function emitSettlementRaceEvent(worker: FakeWorker, event: 'message' | 'error' | 'exit'): void {
  if (event === 'message') {
    worker.emit('message', { id: worker.lastId(), ok: true, value: 'response' })
  } else if (event === 'error') {
    worker.emit('error', new Error('worker race error'))
  } else {
    worker.emit('exit', 1)
  }
}

let context: OpenCodeSqliteScanContext

beforeEach(() => {
  context = new OpenCodeSqliteScanContext()
})

afterEach(() => {
  context.dispose()
})

describe('OpenCodeSqliteWorkerClient', () => {
  it('correlates responses by id and ignores stale ids', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const parsePromise = client.parse({
      context,
      dbPath: '/db#a',
      sessionId: 'a',
      platform: 'darwin'
    })
    const worker = workers[0]
    expect(worker).toBeDefined()
    expect(worker!.unrefed).toBe(true)

    // A response for a different id must not settle the active call.
    worker!.emit('message', {
      id: 999,
      ok: true,
      value: null
    } satisfies OpenCodeSqliteWorkerResponse)
    worker!.emit('message', {
      id: worker!.lastId(),
      ok: true,
      value: { sessionId: 'a' }
    } satisfies OpenCodeSqliteWorkerResponse)

    await expect(parsePromise).resolves.toEqual({ sessionId: 'a' })
  })

  it('dispatches one request at a time in FIFO order', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    const worker = workers[0]!

    // Only the first is dispatched; the second waits for the active slot.
    expect(worker.postedRequests).toHaveLength(1)
    expect(worker.postedRequests[0]).toMatchObject({ kind: 'parse', sessionId: 'a' })

    worker.emit('message', { id: worker.postedRequests[0]!.id, ok: true, value: 'A' })
    await first

    expect(worker.postedRequests).toHaveLength(2)
    expect(worker.postedRequests[1]).toMatchObject({ kind: 'parse', sessionId: 'b' })
    worker.emit('message', { id: worker.postedRequests[1]!.id, ok: true, value: 'B' })
    await expect(second).resolves.toBe('B')
    // The worker is reused across serial calls (one persistent worker).
    expect(workers).toHaveLength(1)
  })

  it('times out only the active call, then respawns and drains the queue', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })

      const active = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      const queued = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
      const activeAssertion = expect(active).rejects.toThrow(/timed out/)

      // The queued call's timer must not have started while it waited, so only
      // the active call fires at the parse timeout.
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      await activeAssertion

      // Fault respawns a fresh worker and dispatches the still-queued call.
      expect(workers).toHaveLength(2)
      const respawned = workers[1]!
      expect(respawned.postedRequests).toHaveLength(1)
      expect(respawned.postedRequests[0]).toMatchObject({ sessionId: 'b' })
      respawned.emit('message', { id: respawned.lastId(), ok: true, value: 'B' })
      await expect(queued).resolves.toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects only the active call on a worker crash and respawns for the queue', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const active = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const queued = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    const activeAssertion = expect(active).rejects.toThrow(/exited with code/)

    workers[0]!.emit('exit', 1)
    await activeAssertion
    expect(workers[0]!.terminated).toBe(true)

    // Exactly one respawn; the queued call drains on the new worker.
    expect(workers).toHaveLength(2)
    const respawned = workers[1]!
    workers[0]!.emit('error', new Error('late old-worker fault'))
    workers[0]!.emit('message', { id: respawned.lastId(), ok: true, value: 'stale' })
    expect(workers).toHaveLength(2)
    respawned.emit('message', { id: respawned.lastId(), ok: true, value: 'B' })
    await expect(queued).resolves.toBe('B')
  })

  it('treats a synchronous postMessage throw as a worker fault', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        const worker = new FakeWorker()
        if (workers.length === 0) {
          worker.postMessageError = new Error('post failed')
        }
        workers.push(worker)
        return worker as unknown as Worker
      },
      log() {}
    })

    await expect(
      client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    ).rejects.toThrow(/post failed/)
    const recovered = client.parse({
      context,
      dbPath: '/db#b',
      sessionId: 'b',
      platform: 'darwin'
    })
    workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
    await expect(recovered).resolves.toBe('B')
  })

  it('uses one queue-inclusive deadline and preserves unrelated FIFO work', async () => {
    vi.useFakeTimers()
    const expiringContext = new OpenCodeSqliteScanContext(10)
    const retainedContext = new OpenCodeSqliteScanContext(1_000)
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      let activeSettlements = 0
      const active = client
        .parse({
          context: expiringContext,
          dbPath: '/db#a',
          sessionId: 'a',
          platform: 'darwin'
        })
        .finally(() => {
          activeSettlements += 1
        })
      const retained = client.parse({
        context: retainedContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const queued = client.parse({
        context: expiringContext,
        dbPath: '/db#a2',
        sessionId: 'a2',
        platform: 'darwin'
      })
      const activeRejection = expect(active).rejects.toThrow(/deadline elapsed/)
      const queuedRejection = expect(queued).rejects.toThrow(/deadline elapsed/)

      await vi.advanceTimersByTimeAsync(10)
      await Promise.all([activeRejection, queuedRejection])
      expect(activeSettlements).toBe(1)
      expect(workers[0]!.terminated).toBe(true)
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
      await expect(retained).resolves.toBe('B')
      expect(expiringContext.metrics()).toMatchObject({
        deadlineExpired: true,
        queueWaitMs: 10,
        workOmitted: true
      })
    } finally {
      expiringContext.dispose()
      retainedContext.dispose()
      vi.useRealTimers()
    }
  })

  it('settles once when the per-call timeout wins a later context abort', async () => {
    vi.useFakeTimers()
    const timeoutContext = new OpenCodeSqliteScanContext(PARSE_TIMEOUT_MS * 2)
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      let settlements = 0
      const outcome = client
        .parse({
          context: timeoutContext,
          dbPath: '/db#a',
          sessionId: 'a',
          platform: 'darwin'
        })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        .finally(() => {
          settlements += 1
        })

      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      await expect(outcome).resolves.toMatch(/timed out/)
      timeoutContext.dispose()
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      expect(settlements).toBe(1)
    } finally {
      timeoutContext.dispose()
      vi.useRealTimers()
    }
  })

  it('cancels queued work without terminating another context active on the worker', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const activeContext = new OpenCodeSqliteScanContext()
    const queuedContext = new OpenCodeSqliteScanContext()
    try {
      const active = client.parse({
        context: activeContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const queued = client.parse({
        context: queuedContext,
        dbPath: '/db#a',
        sessionId: 'a',
        platform: 'darwin'
      })
      const queuedRejection = expect(queued).rejects.toThrow(/scan ended/)

      queuedContext.dispose()
      await queuedRejection
      expect(workers[0]!.terminated).toBe(false)
      workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'B' })
      await expect(active).resolves.toBe('B')
      expect(queuedContext.metrics().workOmitted).toBe(true)
    } finally {
      activeContext.dispose()
      queuedContext.dispose()
    }
  })

  it('dispose cancels active and queued work owned by an exceptional scan exit', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const exceptionalContext = new OpenCodeSqliteScanContext()
    const active = client.parse({
      context: exceptionalContext,
      dbPath: '/db#a',
      sessionId: 'a',
      platform: 'darwin'
    })
    const queued = client.parse({
      context: exceptionalContext,
      dbPath: '/db#a2',
      sessionId: 'a2',
      platform: 'darwin'
    })
    const activeRejection = expect(active).rejects.toThrow(/scan ended/)
    const queuedRejection = expect(queued).rejects.toThrow(/scan ended/)

    exceptionalContext.dispose()
    await Promise.all([activeRejection, queuedRejection])
    expect(workers[0]!.terminated).toBe(true)
    expect(exceptionalContext.metrics().workOmitted).toBe(true)
  })

  it.each(['message', 'error', 'exit'] as const)(
    'settles once when context abort wins the %s race',
    async (event) => {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      let settlements = 0
      const parse = client
        .parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
        .finally(() => {
          settlements += 1
        })
      const rejection = expect(parse).rejects.toThrow(/scan ended/)

      context.dispose()
      await rejection
      emitSettlementRaceEvent(workers[0]!, event)
      await Promise.resolve()
      expect(settlements).toBe(1)
      expect(workers[0]!.terminated).toBe(true)
    }
  )

  it.each(['message', 'error', 'exit'] as const)(
    'settles once when the worker %s wins the context-abort race',
    async (event) => {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      let settlements = 0
      const outcome = client
        .parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
        .then(
          (value) => ({ error: null, value }),
          (error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
            value: null
          })
        )
        .finally(() => {
          settlements += 1
        })

      emitSettlementRaceEvent(workers[0]!, event)
      const settled = await outcome
      context.dispose()
      await Promise.resolve()
      expect(settlements).toBe(1)
      if (event === 'message') {
        expect(settled.error).toBeNull()
      } else {
        expect(settled.error).toEqual(expect.any(String))
      }
    }
  )

  it('fails closed instead of running SQLite on the main thread when spawn fails', async () => {
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        throw new Error('no worker bundle')
      },
      log() {}
    })

    const listIssues: AiVaultScanIssue[] = []
    await expect(
      client.list({ context, dbPaths: ['/tmp/opencode.db'], limit: 10, issues: listIssues })
    ).resolves.toEqual([])
    expect(
      listIssues.some((issue) => /background scanner could not start/.test(issue.message))
    ).toBe(true)
    await expect(
      client.parse({
        context,
        dbPath: '/tmp/opencode.db',
        sessionId: 'ses_skipped',
        platform: 'darwin'
      })
    ).rejects.toThrow(/background scanner could not start/)
  })

  it('rejects already-aborted work without spawning a worker', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const abortedContext = new OpenCodeSqliteScanContext()
    abortedContext.dispose()

    await expect(
      client.parse({
        context: abortedContext,
        dbPath: '/db#a',
        sessionId: 'a',
        platform: 'darwin'
      })
    ).rejects.toThrow(/scan ended/)
    expect(workers).toEqual([])
    expect(abortedContext.metrics().workOmitted).toBe(true)
  })

  it('stops respawning after the consecutive-death cap and fails the rest to issues', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS + 2 }, (_, i) =>
      client.parse({ context, dbPath: `/db#${i}`, sessionId: `s${i}`, platform: 'darwin' })
    )
    const settled = pending.map((promise) => expect(promise).rejects.toThrow())

    // Crash every worker as it is spawned; the client respawns up to the cap.
    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      expect(workers[i]).toBeDefined()
      workers[i]!.emit('error', new Error(`crash ${i}`))
    }

    await Promise.all(settled)
    // No respawn past the cap: only MAX_CONSECUTIVE_DEATHS workers were created,
    // and the queued remainder failed to scan issues rather than looping.
    expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS)
  })

  it('surfaces a list-leg timeout as a scan issue and returns no candidates', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      const issues: AiVaultScanIssue[] = []
      const listPromise = client.list({
        context,
        dbPaths: ['/tmp/opencode.db'],
        limit: 10,
        issues
      })
      // The list request is dispatched but never answered → it must time out into
      // a scan issue (not an unbounded stall) and contribute no sessions.
      await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS)
      await expect(listPromise).resolves.toEqual([])
      expect(issues).toHaveLength(1)
      expect(issues[0]!.agent).toBe('opencode')
      expect(issues[0]!.message).toMatch(/did not complete/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-heals after repeated spawn failures instead of latching unavailable', async () => {
    const workers: FakeWorker[] = []
    let failSpawns = true
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        if (failSpawns) {
          throw new Error('spawn down')
        }
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      log() {}
    })
    // Scan 1: both calls fail closed, keeping synchronous SQLite off the main
    // thread. The failure is not latched, so a later scan can still recover.
    const firstIssues: AiVaultScanIssue[] = []
    const first = await client.list({ context, dbPaths: ['/db'], limit: 10, issues: firstIssues })
    expect(first).toEqual([])
    expect(
      firstIssues.some((issue) => /background scanner could not start/.test(issue.message))
    ).toBe(true)
    await expect(
      client.parse({ context, dbPath: '/db', sessionId: 'ses_heal', platform: 'darwin' })
    ).rejects.toThrow(/background scanner could not start/)
    expect(workers).toHaveLength(0)

    // Spawns recover; the next scan must re-probe and use the worker.
    failSpawns = false
    const secondIssues: AiVaultScanIssue[] = []
    const secondPromise = client.list({
      context,
      dbPaths: ['/db'],
      limit: 10,
      issues: secondIssues
    })
    const worker = workers[0]
    expect(worker).toBeDefined()
    worker!.emit('message', {
      id: worker!.lastId(),
      ok: true,
      value: { candidates: [], issues: [] }
    } satisfies OpenCodeSqliteWorkerResponse)
    await expect(secondPromise).resolves.toEqual([])
    expect(secondIssues).toHaveLength(0)
  })

  it('drops a cleanly exited idle worker and respawns on the next request', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
    await expect(first).resolves.toBe('A')
    workers[0]!.emit('exit', 0)

    const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    expect(workers).toHaveLength(2)
    workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
    await expect(second).resolves.toBe('B')
  })

  it('terminates an idle worker and respawns on later work', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })

      const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
      await expect(first).resolves.toBe('A')
      await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
      expect(workers[0]!.terminated).toBe(true)

      const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
      await expect(second).resolves.toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains scan fault state across queue-empty parser batches', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const otherContext = new OpenCodeSqliteScanContext()
    const addListener = vi.spyOn(context.signal, 'addEventListener')
    const removeListener = vi.spyOn(context.signal, 'removeEventListener')

    try {
      for (let index = 0; index < MAX_CONSECUTIVE_DEATHS - 1; index += 1) {
        const batch = client.parse({
          context,
          dbPath: `/db#a${index}`,
          sessionId: `a${index}`,
          platform: 'darwin'
        })
        const rejection = expect(batch).rejects.toThrow(/batch crash/)
        workers.at(-1)!.emit('error', new Error(`batch crash ${index}`))
        await rejection
        expect(addListener).toHaveBeenCalledTimes(index + 1)
        expect(removeListener).toHaveBeenCalledTimes(index + 1)

        const interleaved = client.parse({
          context: otherContext,
          dbPath: `/db#b${index}`,
          sessionId: `b${index}`,
          platform: 'darwin'
        })
        workers.at(-1)!.emit('message', {
          id: workers.at(-1)!.lastId(),
          ok: true,
          value: `B${index}`
        })
        await expect(interleaved).resolves.toBe(`B${index}`)
      }

      const third = client.parse({
        context,
        dbPath: '/db#a2',
        sessionId: 'a2',
        platform: 'darwin'
      })
      const retained = client.parse({
        context: otherContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const skipped = client.parse({
        context,
        dbPath: '/db#a3',
        sessionId: 'a3',
        platform: 'darwin'
      })
      const thirdRejection = expect(third).rejects.toThrow(/third crash/)
      const skippedRejection = expect(skipped).rejects.toThrow(/crashed repeatedly/)
      workers.at(-1)!.emit('error', new Error('third crash'))
      await Promise.all([thirdRejection, skippedRejection])

      const retainedWorker = workers.at(-1)!
      retainedWorker.emit('message', {
        id: retainedWorker.lastId(),
        ok: true,
        value: 'B'
      })
      await expect(retained).resolves.toBe('B')
      expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS + 1)
      expect(addListener).toHaveBeenCalledTimes(MAX_CONSECUTIVE_DEATHS)
      expect(removeListener).toHaveBeenCalledTimes(MAX_CONSECUTIVE_DEATHS)
    } finally {
      otherContext.dispose()
    }
  })

  it('reuses the warm worker across a burst without respawning', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    for (let i = 0; i < 3; i++) {
      const promise = client.parse({
        context,
        dbPath: `/db#${i}`,
        sessionId: `s${i}`,
        platform: 'darwin'
      })
      const worker = workers[0]!
      worker.emit('message', { id: worker.lastId(), ok: true, value: `v${i}` })
      await expect(promise).resolves.toBe(`v${i}`)
    }
    expect(workers).toHaveLength(1)
  })
})
