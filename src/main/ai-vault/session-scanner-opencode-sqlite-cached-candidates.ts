import { sessionParseCacheEntries } from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

/**
 * Rebuild OpenCode SQLite candidates for `dbPaths` from entries already in the
 * parse cache. Used when the SQLite listing leg is skipped (cooldown, spent
 * budget): the listing is the only producer of `<dbPath>#<sessionId>`
 * candidates, so without this a paused scanner blanks every SQLite-backed
 * session even though this scan could still serve them for free. Replayed rows
 * carry their cached mtime, so `hasFreshSessionParseCacheEntry` keeps them off
 * the worker.
 * @param args.dbPaths - Databases this source would have listed.
 * @param args.platform - Only entries parsed on this platform are reusable.
 * @param args.limit - Maximum candidates to return.
 * @returns Candidates newest-first, capped at `limit`.
 */
export function cachedOpenCodeSqliteCandidates(args: {
  dbPaths: readonly string[]
  platform: NodeJS.Platform
  limit: number
}): SessionFileCandidate[] {
  if (args.dbPaths.length === 0 || args.limit <= 0) {
    return []
  }
  const prefixes = args.dbPaths.map((dbPath) => `${dbPath}#`)
  const candidates: SessionFileCandidate[] = []
  for (const [path, entry] of sessionParseCacheEntries()) {
    if (
      entry.platform !== args.platform ||
      entry.session === null ||
      !prefixes.some((prefix) => path.startsWith(prefix))
    ) {
      continue
    }
    candidates.push({
      agent: 'opencode',
      codexHome: null,
      file: {
        path,
        mtimeMs: entry.mtimeMs,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
        ...(entry.sizeBytes === null ? {} : { sizeBytes: entry.sizeBytes })
      }
    })
  }
  return candidates
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
    .slice(0, args.limit)
}
