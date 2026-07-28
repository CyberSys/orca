import type { AiVaultListResult, AiVaultScanIssue } from '../../../../shared/ai-vault-types'

export function blockingAiVaultScanIssue(
  result: AiVaultListResult | null
): AiVaultScanIssue | null {
  if (!result || result.sessions.length > 0) {
    return null
  }
  return result.issues.find((issue) => issue.kind === 'host') ?? null
}

// Host and scope issues carry their own scanner-authored copy, so they get their
// own rows instead of being counted as skipped transcripts — a partial scan
// (one SSH host down, rest fine) must not report a connectivity failure as a
// skipped transcript file.
export function aiVaultScanNoticeIssues(result: AiVaultListResult | null): AiVaultScanIssue[] {
  if (!result) {
    return []
  }
  const blocking = blockingAiVaultScanIssue(result)
  return result.issues.filter((issue) => Boolean(issue.kind) && issue !== blocking)
}

export function skippedAiVaultTranscriptCount(result: AiVaultListResult | null): number {
  return result ? result.issues.filter((issue) => !issue.kind).length : 0
}
