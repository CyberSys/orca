import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import Database from '../sqlite/sync-database'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import type { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import type { SessionParseStats } from './session-scanner-parse-cache'
import type * as GrokParserModule from './session-scanner-grok-parser'
import type * as ParseCachePersistenceModule from './session-parse-cache-persistence'

type WorkerListArgs = {
  context: OpenCodeSqliteScanContext
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
}

type WorkerParseArgs = {
  context: OpenCodeSqliteScanContext
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}

const workerMock = vi.hoisted(() => ({
  listCalls: 0,
  parseCalls: 0,
  listOverride: null as null | ((args: WorkerListArgs) => Promise<SessionFileCandidate[]>),
  parseOverride: null as null | ((args: WorkerParseArgs) => Promise<AiVaultSession | null>)
}))

const grokMock = vi.hoisted(() => ({
  calls: 0,
  override: null as null | (() => Promise<AiVaultSession | null>)
}))

const persistenceMock = vi.hoisted(() => ({
  lastStats: null as SessionParseStats | null
}))

// Why: this source-level integration suite has no built worker entry. Keep its
// SQLite fixtures inline explicitly; production fails closed if the bundle is absent.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const [{ listOpenCodeSqliteSessions }, { parseOpenCodeSqliteSession }] = await Promise.all([
    import('./session-scanner-opencode-sqlite-list'),
    import('./session-scanner-opencode-sqlite')
  ])
  return {
    listOpenCodeSqliteSessionsViaWorker: (args: WorkerListArgs) => {
      workerMock.listCalls += 1
      return workerMock.listOverride?.(args) ?? listOpenCodeSqliteSessions(args)
    },
    parseOpenCodeSqliteSessionViaWorker: (args: WorkerParseArgs) => {
      workerMock.parseCalls += 1
      return workerMock.parseOverride?.(args) ?? parseOpenCodeSqliteSession(args)
    }
  }
})

vi.mock('./session-scanner-grok-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof GrokParserModule>()
  return {
    ...actual,
    parseGrokSessionFile: (...args: Parameters<typeof actual.parseGrokSessionFile>) => {
      grokMock.calls += 1
      return grokMock.override?.() ?? actual.parseGrokSessionFile(...args)
    }
  }
})

vi.mock('./session-parse-cache-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof ParseCachePersistenceModule>()
  return {
    ...actual,
    scheduleSessionParseCachePersist(stats: SessionParseStats) {
      persistenceMock.lastStats = { ...stats }
      actual.scheduleSessionParseCachePersist(stats)
    }
  }
})

let tempRoots: string[] = []
let tempDbDirs: string[] = []

afterEach(async () => {
  workerMock.listCalls = 0
  workerMock.parseCalls = 0
  workerMock.listOverride = null
  workerMock.parseOverride = null
  grokMock.calls = 0
  grokMock.override = null
  persistenceMock.lastStats = null
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  for (const dir of tempDbDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempRoots = []
  tempDbDirs = []
})

function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    antigravityBrainDir: join(root, 'antigravity-brain'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions'),
    ompSessionsDir: join(root, 'omp-sessions')
  }
}

function createTempOpenCodeDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ai-vault-sqlite-'))
  tempDbDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

function applyOpenCodeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      model TEXT,
      agent TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

describe('scanAiVaultSessions — OpenCode SQLite + legacy file coexistence', () => {
  it('stops native and WSL SQLite parsing at one scan deadline', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-deadline-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      const nativeDataDir = join(root, 'native-opencode')
      const wslHome = join(root, 'wsl-home')
      await mkdir(join(nativeDataDir, 'storage'), { recursive: true })
      await mkdir(join(wslHome, '.local', 'share', 'opencode'), { recursive: true })
      await writeFile(join(nativeDataDir, 'opencode.db'), '')
      await writeFile(join(wslHome, '.local', 'share', 'opencode', 'opencode.db'), '')

      workerMock.listOverride = async (args) =>
        args.dbPaths.flatMap((dbPath, sourceIndex) =>
          Array.from({ length: 120 }, (_, candidateIndex) => ({
            agent: 'opencode' as const,
            codexHome: null,
            file: {
              path: buildOpenCodeSqliteCandidatePath(
                dbPath,
                `session-${sourceIndex}-${candidateIndex}`
              ),
              mtimeMs: 10_000 - candidateIndex,
              modifiedAt: new Date(10_000 - candidateIndex).toISOString()
            }
          }))
        )
      workerMock.parseOverride = (args) =>
        new Promise((_, reject) => {
          const rejectTerminated = (): void => {
            args.context.markWorkOmitted()
            reject(args.context.terminationError())
          }
          if (args.context.isTerminated) {
            rejectTerminated()
          } else {
            args.context.signal.addEventListener('abort', rejectTerminated, { once: true })
          }
        })

      const scan = scanAiVaultSessions({
        ...roots,
        opencodeStorageDir: join(nativeDataDir, 'storage'),
        opencodeDbPaths: undefined,
        wslHomeDirs: [wslHome],
        limit: 500
      })
      await vi.waitFor(() => expect(workerMock.parseCalls).toBe(8))
      await vi.advanceTimersByTimeAsync(45_000)
      const result = await scan

      expect(workerMock.listCalls).toBe(2)
      expect(workerMock.parseCalls).toBe(8)
      expect(persistenceMock.lastStats?.fullParses).toBe(8)
      expect(result.sessions).toEqual([])
      expect(
        result.issues.filter((issue) => /OpenCode history was skipped/.test(issue.message))
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms after the last SQLite promise while a mixed-batch parser remains active', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-mixed-disarm-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      await mkdir(roots.grokSessionsDir, { recursive: true })
      await writeFile(join(roots.grokSessionsDir, 'summary.json'), '{}')

      let context: OpenCodeSqliteScanContext | null = null
      let finishGrok: (() => void) | null = null
      workerMock.listOverride = async (args) => {
        context = args.context
        return [
          {
            agent: 'opencode',
            codexHome: null,
            file: {
              path: buildOpenCodeSqliteCandidatePath('/data/opencode.db', 'mixed-session'),
              mtimeMs: Date.now(),
              modifiedAt: new Date().toISOString()
            }
          }
        ]
      }
      workerMock.parseOverride = async (args) => {
        context = args.context
        return null
      }
      grokMock.override = () =>
        new Promise((resolve) => {
          finishGrok = () => resolve(null)
        })

      const scan = scanAiVaultSessions({ ...roots, limit: 10 })
      await vi.waitFor(() => {
        expect(workerMock.parseCalls).toBe(1)
        expect(grokMock.calls).toBe(1)
      })
      await vi.advanceTimersByTimeAsync(45_000)
      expect(context).not.toBeNull()
      expect(context!.metrics().deadlineExpired).toBe(false)

      finishGrok!()
      await expect(scan).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms a no-database scan before unrelated parsing completes', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-no-db-disarm-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      await mkdir(roots.grokSessionsDir, { recursive: true })
      await writeFile(join(roots.grokSessionsDir, 'summary.json'), '{}')

      let context: OpenCodeSqliteScanContext | null = null
      let finishGrok: (() => void) | null = null
      workerMock.listOverride = async (args) => {
        context = args.context
        return []
      }
      grokMock.override = () =>
        new Promise((resolve) => {
          finishGrok = () => resolve(null)
        })

      const scan = scanAiVaultSessions({ ...roots, limit: 10 })
      await vi.waitFor(() => expect(grokMock.calls).toBe(1))
      await vi.advanceTimersByTimeAsync(45_000)
      expect(context).not.toBeNull()
      expect(context!.metrics().deadlineExpired).toBe(false)

      finishGrok!()
      await expect(scan).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discovers SQLite sessions next to a custom OpenCode storage directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-custom-opencode-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const opencodeDataDir = join(root, 'custom-opencode')
    const opencodeStorageDir = join(opencodeDataDir, 'storage')
    await mkdir(opencodeStorageDir, { recursive: true })

    const dbPath = join(opencodeDataDir, 'opencode.db')
    const db = new Database(dbPath)
    applyOpenCodeSchema(db)
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('custom-db-session', 'proj-1', 'slug', '/tmp/custom-opencode',
         'Custom SQLite session', '1.0.0',
         1777634010000, 1777634011000, NULL, 'build', 0,
         8, 13, 21, 34, 0)`
    ).run()
    db.close()

    const result = await scanAiVaultSessions({
      ...roots,
      opencodeStorageDir,
      opencodeDbPaths: undefined,
      platform: 'darwin',
      limit: 50
    })

    const session = result.sessions.find((s) => s.sessionId === 'custom-db-session')
    expect(session).toBeDefined()
    expect(session!.agent).toBe('opencode')
    expect(session!.title).toBe('Custom SQLite session')
    expect(session!.filePath).toBe(dbPath)
    expect(session!.totalTokens).toBe(42)
  })

  it('surfaces SQLite sessions alongside legacy file sessions and dedups by sessionId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-mixed-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    // Legacy file session under storage/session/<projectId>/<sessionId>.json
    await mkdir(join(roots.opencodeStorageDir, 'session', 'project'), { recursive: true })
    await mkdir(join(roots.opencodeStorageDir, 'message', 'legacy-session'), { recursive: true })
    await writeFile(
      join(roots.opencodeStorageDir, 'session', 'project', 'legacy-session.json'),
      JSON.stringify({
        id: 'legacy-session',
        directory: '/tmp/legacy',
        title: 'Legacy file session',
        time: { created: 1_777_634_000_000, updated: 1_777_634_001_000 }
      })
    )
    await writeFile(
      join(roots.opencodeStorageDir, 'message', 'legacy-session', 'msg_1.json'),
      JSON.stringify({
        role: 'user',
        summary: { title: 'Legacy file session' },
        time: { created: 1_777_634_000_000 },
        tokens: { input: 5, output: 2 }
      })
    )

    // SQLite session — same sessionId as the legacy file (dedup should keep SQLite)
    const { db, path: dbPath } = createTempOpenCodeDb()
    applyOpenCodeSchema(db)
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('legacy-session', 'proj-1', 'slug', '/tmp/sqlite', 'SQLite session', '1.0.0',
         1777634002000, 1777634003000, ?, 'build', 0,
         100, 40, 10, 5, 0)`
    ).run(JSON.stringify({ id: 'glm-5.2', providerID: 'zai-coding-plan' }))
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES ('msg_sql_1', 'legacy-session', 1777634002500, 1777634002500, ?)`
    ).run(JSON.stringify({ role: 'user', time: { created: 1_777_634_002_500 } }))
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES ('prt_sql_1', 'msg_sql_1', 'legacy-session', 1777634002500, 1777634002500, ?)`
    ).run(JSON.stringify({ type: 'text', text: 'sqlite hello' }))
    db.close()

    // A second SQLite-only session
    const { db: db2, path: dbPath2 } = createTempOpenCodeDb()
    applyOpenCodeSchema(db2)
    db2
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version,
         time_created, time_updated, model, agent, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
       VALUES ('sqlite-only', 'proj-1', 'slug2', '/tmp/sqlite-only', 'SQLite only', '1.0.0',
         1777634004000, 1777634005000, NULL, 'build', 0,
         50, 20, 0, 0, 0)`
      )
      .run()
    db2.close()

    const result = await scanAiVaultSessions({
      ...roots,
      opencodeDbPaths: [dbPath, dbPath2],
      platform: 'darwin',
      limit: 50
    })

    const opencodeSessions = result.sessions.filter((s) => s.agent === 'opencode')
    const sessionIds = opencodeSessions.map((s) => s.sessionId).sort()
    expect(sessionIds).toEqual(['legacy-session', 'sqlite-only'])

    // Why: dedup keeps the SQLite entry (newer time_updated, source of truth)
    const legacyEntry = opencodeSessions.find((s) => s.sessionId === 'legacy-session')
    expect(legacyEntry).toBeDefined()
    expect(legacyEntry!.title).toBe('SQLite session')
    expect(legacyEntry!.cwd).toBe('/tmp/sqlite')
    expect(legacyEntry!.filePath).toBe(dbPath)
    expect(legacyEntry!.totalTokens).toBe(150)
    expect(legacyEntry!.resumeCommand).toBe(
      "cd '/tmp/sqlite' && opencode --session 'legacy-session'"
    )
  })
})
