import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const REMOTE_SCAN_ISSUE_LIMIT = 500

export function recordRemoteSessionScanIssue(
  issues: AiVaultScanIssue[],
  issue: AiVaultScanIssue
): void {
  if (issues.length < REMOTE_SCAN_ISSUE_LIMIT - 1) {
    issues.push(issue)
    return
  }
  if (issues.length === REMOTE_SCAN_ISSUE_LIMIT - 1) {
    issues.push({
      executionHostId: issue.executionHostId,
      agent: issue.agent,
      path: 'Agent Session History scan',
      message: 'Additional scan issues were omitted.'
    })
  }
}
