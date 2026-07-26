import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases,
  dedupeCodexSessionsBySessionId
} from './codex-session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  readOptionalAntigravityHistoryFile,
  type AntigravityWorkspaceResolver
} from './session-scanner-antigravity-history'
import { antigravityHistoryPathForBrainDir } from './session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import {
  ensureSessionParseCacheLoaded,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { discoverInScopeClaudeFiles } from './session-scanner-scope-discovery'
import {
  DEFAULT_CODEX_HOME_DIR,
  discoverAiVaultSessionSources
} from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery,
  SessionParseResult
} from './session-scanner-types'
import { clampPositiveInteger, errorMessage } from './session-scanner-values'
import {
  isOpenCodeSqliteScanTerminatedError,
  OpenCodeSqliteScanContext
} from './session-scanner-opencode-sqlite-scan-context'
import { recordOpenCodeSqliteScanOutcome } from './session-scanner-opencode-sqlite-scan-outcome'
import { OpenCodeSqliteCandidatePhase } from './session-scanner-opencode-sqlite-candidate-phase'
import { withSessionExecutionHost } from './session-scanner-execution-host'
import { mergeSessions } from './session-scanner-session-merge'

const DEFAULT_LIMIT = 1000
const DEFAULT_SCAN_LIMIT_PER_AGENT = 1000
const SESSION_PARSE_CONCURRENCY = 8
// Upper bound on extra in-scope transcripts discovered and parsed past the
// recency cap; guards against a pathological scoped history directory.
const SCOPE_PARSE_LIMIT = 2000

/**
 * Scan all supported AI agent session stores and return a unified, sorted,
 * deduplicated list of sessions for the AI Vault panel. Discovers sessions
 * from file-based stores (Claude, Codex, Gemini, etc.) and SQLite-based
 * stores (OpenCode 1.17.x). Results are sorted by session sort time DESC
 * and truncated to `limit`.
 * @param options - Optional scan configuration (limits, custom dirs, platform).
 * @returns The list of sessions, scan issues, and a timestamp.
 */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  // The span makes scan cost visible in the local trace file: STA-1278-style
  // "one core pegged" reports need to show whether transcript scanning is the
  // subsystem burning CPU, and how much of each scan the cache absorbed.
  return withSpan('aiVault.scan', async (span) => {
    const opencodeSqliteScanContext = new OpenCodeSqliteScanContext()
    try {
      const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT)
      const limitPerAgent = clampPositiveInteger(
        options.limitPerAgent,
        DEFAULT_SCAN_LIMIT_PER_AGENT
      )
      const platform = options.platform ?? process.platform
      const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID
      const issues: AiVaultScanIssue[] = []
      const parseStats = createSessionParseStats()
      const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver(
        readOptionalAntigravityHistoryFile
      )
      // Why: persisted entries must be seeded before any candidate is parsed, or
      // the cold scan gains nothing from the cache file (#9210).
      await ensureSessionParseCacheLoaded()
      const discoveries = await discoverAiVaultSessionSources({
        options,
        limitPerAgent,
        issues,
        opencodeSqliteScanContext
      })

      const candidates = dedupeCodexRolloutFileAliases(
        discoveries
          .flatMap((discovery) =>
            discovery.files.map(
              (file): SessionFileCandidate => ({
                agent: discovery.agent,
                file,
                codexHome:
                  discovery.agent === 'codex'
                    ? codexHomeForSessionsDir(
                        discovery.rootDir,
                        options.defaultCodexHomeDir ?? DEFAULT_CODEX_HOME_DIR
                      )
                    : null,
                antigravityHistoryPath:
                  discovery.agent === 'antigravity'
                    ? antigravityHistoryPathForBrainDir(discovery.rootDir)
                    : undefined
              })
            )
          )
          .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs),
        {
          isCodex: (candidate) => candidate.agent === 'codex',
          getFilePath: (candidate) => candidate.file.path,
          getCodexHome: (candidate) => candidate.codexHome,
          getHardlinkIdentity: (candidate) => codexRolloutHardlinkIdentity(candidate.file)
        }
      )

      const parsedSessions = await parseSessionCandidates({
        candidates,
        limit,
        platform,
        executionHostId,
        issues,
        parseStats,
        antigravityWorkspaceResolver,
        opencodeSqliteScanContext
      })
      opencodeSqliteScanContext.disarmDeadline()

      const cappedSessions = dedupeCodexSessionsBySessionId(parsedSessions)
        .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
        .slice(0, limit)

      const scopeSessions = await scanInScopeSessions({
        discoveries,
        scopePaths: options.scopePaths ?? [],
        alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
        platform,
        executionHostId,
        issues,
        parseStats
      })

      span.setAttribute('candidates', candidates.length)
      span.setAttribute('reused', parseStats.reused)
      span.setAttribute('incremental', parseStats.incremental)
      span.setAttribute('fullParses', parseStats.fullParses)
      span.setAttribute('bytesRead', parseStats.bytesRead)
      recordOpenCodeSqliteScanOutcome({
        candidates,
        context: opencodeSqliteScanContext,
        discoveries,
        issues,
        span
      })
      span.setAttribute('issues', issues.length)

      scheduleSessionParseCachePersist(parseStats)

      return {
        sessions: mergeSessions(cappedSessions, scopeSessions),
        issues: issues.map((issue) => ({ executionHostId, ...issue })),
        scannedAt: new Date().toISOString()
      }
    } finally {
      opencodeSqliteScanContext.dispose()
    }
  })
}

async function scanInScopeSessions(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }
  const claudeRootDirs = args.discoveries
    .filter((discovery) => discovery.agent === 'claude')
    .map((discovery) => discovery.rootDir)
  const files = await discoverInScopeClaudeFiles({
    rootDirs: claudeRootDirs,
    scopePaths: args.scopePaths,
    limit: SCOPE_PARSE_LIMIT,
    excludedFilePaths: args.alreadyParsedFilePaths,
    issues: args.issues
  })
  const candidates = files.map(
    (file): SessionFileCandidate => ({ agent: 'claude', file, codexHome: null })
  )
  if (candidates.length === 0) {
    return []
  }
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  return parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats
  })
}

async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
  opencodeSqliteScanContext?: OpenCodeSqliteScanContext
}): Promise<AiVaultSession[]> {
  const sessions: AiVaultSession[] = []
  let index = 0
  const opencodePhase = new OpenCodeSqliteCandidatePhase(
    args.candidates,
    args.opencodeSqliteScanContext
  )

  while (index < args.candidates.length) {
    if (canStopParsingSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.length, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const parseableBatch = opencodePhase.prepareBatch(batch)
    const results = await Promise.all(
      parseableBatch.map((candidate) =>
        parseSessionCandidate(
          candidate,
          args.platform,
          args.executionHostId,
          args.parseStats,
          args.antigravityWorkspaceResolver,
          args.opencodeSqliteScanContext
        )
      )
    )
    opencodePhase.completeBatch()

    for (const result of results) {
      if (result.issue) {
        args.issues.push(result.issue)
      }
      if (result.session) {
        sessions.push(result.session)
      }
    }

    // Why: cross-volume backfill copies have no shared inode, so collapse
    // parsed aliases before they can crowd the unique-session parse budget.
    const uniqueSessions = dedupeCodexSessionsBySessionId(sessions)
    sessions.splice(0, sessions.length, ...uniqueSessions)

    index += batchSize
  }

  opencodePhase.finish()
  return sessions
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver,
  opencodeSqliteScanContext?: OpenCodeSqliteScanContext
): Promise<SessionParseResult> {
  try {
    let session = await parseAgentSessionFileCached(
      candidate,
      platform,
      parseStats,
      opencodeSqliteScanContext
    )
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: null
    }
  } catch (err) {
    if (isOpenCodeSqliteScanTerminatedError(err)) {
      return { session: null, issue: null }
    }
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

function canStopParsingSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtime is already our discovery bound and fallback sort key; older
  // files cannot displace the current visible set once the cutoff is newer.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}
