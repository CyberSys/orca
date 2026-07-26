import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ActiveSpan } from '../observability/tracer'
import { looksLikeOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import type { SessionFileCandidate, SessionFileDiscovery } from './session-scanner-types'

export function recordOpenCodeSqliteScanOutcome(args: {
  candidates: readonly SessionFileCandidate[]
  context: OpenCodeSqliteScanContext
  discoveries: readonly SessionFileDiscovery[]
  issues: AiVaultScanIssue[]
  span: ActiveSpan
}): void {
  const metrics = args.context.metrics()
  args.span.setAttribute('opencodeSqliteDeadlineExpired', metrics.deadlineExpired)
  args.span.setAttribute('opencodeSqliteQueueWaitMs', metrics.queueWaitMs)
  args.span.setAttribute('opencodeSqliteActiveWorkerMs', metrics.activeWorkerMs)
  args.span.setAttribute(
    'opencodeSqliteSources',
    args.discoveries.filter((discovery) => discovery.agent === 'opencode').length
  )
  args.span.setAttribute(
    'opencodeSqliteCandidates',
    args.candidates.filter((candidate) => looksLikeOpenCodeSqliteCandidate(candidate.file.path))
      .length
  )
  if (metrics.workOmitted) {
    args.issues.push({
      agent: 'opencode',
      path: 'opencode.db',
      message: 'Some OpenCode history was skipped after its SQLite scan budget ended.'
    })
  }
}
