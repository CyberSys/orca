import type React from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { aiVaultScanNoticeIssues, blockingAiVaultScanIssue } from './ai-vault-scan-issue-state'

// Messages are scanner-authored (host name, remote path, cap), so they render raw
// rather than through a catalog key.
export function AiVaultScanIssueBanners({
  scanResult
}: {
  scanResult: AiVaultListResult | null
}): React.JSX.Element {
  const blocking = blockingAiVaultScanIssue(scanResult)

  return (
    <>
      {blocking ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {blocking.message}
        </div>
      ) : null}
      {aiVaultScanNoticeIssues(scanResult).map((issue) => (
        <div
          key={`${issue.executionHostId ?? 'local'}:${issue.kind}:${issue.path}`}
          className={`border-b border-sidebar-border px-3 py-1.5 text-[11px] ${
            issue.kind === 'host' ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {issue.message}
        </div>
      ))}
    </>
  )
}
