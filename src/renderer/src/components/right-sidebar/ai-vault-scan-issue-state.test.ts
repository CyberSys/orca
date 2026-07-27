import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { blockingAiVaultScanIssue } from './ai-vault-scan-issue-state'

describe('blockingAiVaultScanIssue', () => {
  it('surfaces the cause when a scan returns no sessions', () => {
    const issue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped. Reconnect the SSH target.'
    }

    expect(blockingAiVaultScanIssue(result([], [issue]))).toEqual(issue)
  })

  it('leaves partial-result issues as a skipped transcript count', () => {
    expect(
      blockingAiVaultScanIssue(
        result(
          [{ id: 'session' }],
          [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }]
        )
      )
    ).toBeNull()
  })

  it('does not block an empty scan for a skipped transcript', () => {
    expect(
      blockingAiVaultScanIssue(
        result([], [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }])
      )
    ).toBeNull()
  })
})

function result(
  sessions: { id: string }[],
  issues: AiVaultListResult['issues']
): AiVaultListResult {
  return {
    sessions: sessions as AiVaultListResult['sessions'],
    issues,
    scannedAt: '2026-07-26T00:00:00.000Z'
  }
}
