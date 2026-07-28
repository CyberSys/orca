import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultScanIssue
} from '../../shared/ai-vault-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getActiveSshAiVaultHostInfo, requestActiveSshAiVaultSessionList } from '../ipc/ssh'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { parseAiVaultListResult } from './session-list-result-validation'
import { aiVaultScanIssueResult, restampAiVaultListResult } from './session-list-results'

export async function scanSshAiVaultSessions(
  targetId: string,
  args?: AiVaultListArgs,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<AiVaultListResult> {
  const executionHostId = toSshExecutionHostId(targetId)
  // Both legs scan the same capped set, so the fallback can't quietly scan more
  // paths — or skip the truncation notice — than the relay leg would.
  const scopePaths = args?.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  const scopePathsTruncated = (args?.scopePaths?.length ?? 0) > AI_VAULT_SCOPE_PATHS_MAX_COUNT
  let relayError: unknown
  try {
    const params = {
      limit: args?.limit,
      scopePaths,
      ...(scopePathsTruncated ? { scopePathsTruncated: true } : {})
    }
    const relayResult =
      options.signal || options.timeoutMs !== undefined
        ? await requestActiveSshAiVaultSessionList(targetId, params, options)
        : await requestActiveSshAiVaultSessionList(targetId, params)
    if (relayResult !== null) {
      return restampAiVaultListResult(parseAiVaultListResult(relayResult), executionHostId)
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (isRelayScanTimeout(error)) {
      return sshScanIssueResult(executionHostId, targetId, errorMessage(error))
    }
    relayError = error
  }
  const hostInfo = getActiveSshAiVaultHostInfo(targetId)
  const provider = getSshFilesystemProvider(targetId)
  if (!hostInfo || !provider) {
    return sshScanIssueResult(
      executionHostId,
      targetId,
      relayError ? errorMessage(relayError) : SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    )
  }
  const fallbackResult = await scanRemoteAiVaultSessions({
    provider,
    executionHostId,
    remoteHome: hostInfo.remoteHome,
    hostPlatform: hostInfo.hostPlatform,
    limit: args?.limit,
    scopePaths,
    signal: options.signal
  })
  const scopeIssues = scopePathsTruncated
    ? [scopeTruncationIssue(executionHostId, hostInfo.remoteHome)]
    : []
  if (!relayError || fallbackResult.sessions.length > 0 || fallbackResult.issues.length === 0) {
    return { ...fallbackResult, issues: [...fallbackResult.issues, ...scopeIssues] }
  }
  return {
    ...fallbackResult,
    issues: [
      ...sshScanIssueResult(executionHostId, targetId, errorMessage(relayError)).issues,
      ...fallbackResult.issues,
      ...scopeIssues
    ]
  }
}

// Mirrors the notice the relay leg appends so both legs report the same cap.
function scopeTruncationIssue(
  executionHostId: `ssh:${string}`,
  remoteHome: string
): AiVaultScanIssue {
  return {
    executionHostId,
    agent: 'codex',
    kind: 'scope',
    path: remoteHome,
    message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
  }
}

function sshScanIssueResult(
  executionHostId: `ssh:${string}`,
  targetId: string,
  message: string
): AiVaultListResult {
  return aiVaultScanIssueResult({ executionHostId, path: targetId, message })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRelayScanTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timed out after')
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Agent Session History scan failed on the SSH target.'
}
