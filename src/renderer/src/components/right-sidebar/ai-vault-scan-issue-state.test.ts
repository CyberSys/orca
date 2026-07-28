import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  aiVaultScanNoticeIssues,
  blockingAiVaultScanIssue,
  skippedAiVaultTranscriptCount
} from './ai-vault-scan-issue-state'

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

describe('aiVaultScanNoticeIssues', () => {
  it('keeps kinded issues as notices and counts only transcripts as skipped', () => {
    const hostIssue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped.'
    }
    const scopeIssue = {
      agent: 'codex' as const,
      kind: 'scope' as const,
      path: '/home/ada',
      message: 'Only the first 64 project paths were scanned.'
    }
    const partial = result(
      [{ id: 'session' }],
      [hostIssue, scopeIssue, { agent: 'codex', path: '/bad.jsonl', message: 'Malformed' }]
    )

    expect(aiVaultScanNoticeIssues(partial)).toEqual([hostIssue, scopeIssue])
    expect(skippedAiVaultTranscriptCount(partial)).toBe(1)
  })

  it('does not repeat the blocking issue as a notice row', () => {
    const hostIssue = {
      executionHostId: 'ssh:dev-box' as const,
      agent: 'codex' as const,
      kind: 'host' as const,
      path: 'dev-box',
      message: 'Remote connection dropped.'
    }

    expect(aiVaultScanNoticeIssues(result([], [hostIssue]))).toEqual([])
  })

  it('reports nothing before the first scan', () => {
    expect(aiVaultScanNoticeIssues(null)).toEqual([])
    expect(skippedAiVaultTranscriptCount(null)).toBe(0)
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
