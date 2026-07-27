import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { AiVaultListResult } from '../shared/ai-vault-types'
import { AI_VAULT_SCOPE_PATHS_MAX_COUNT } from '../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import {
  SSH_AI_VAULT_LIST_LIMIT_MAX,
  SSH_AI_VAULT_LIST_SESSIONS_METHOD,
  SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH,
  type SshAiVaultRelayListParams
} from '../shared/ssh-ai-vault-relay'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import type { RemoteSessionFilesystemProvider } from '../main/ai-vault/remote-session-scanner-types'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { parseUnameToRelayPlatform } from '../main/ssh/relay-protocol'
import { readRelayFileContent } from './fs-handler-file-read'
import type { RelayDispatcher } from './dispatcher'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'

type ScanRemoteSessions = typeof scanRemoteAiVaultSessions

type AiVaultHandlerOptions = {
  remoteHome?: string
  hostPlatform?: RemoteHostPlatform
  scanRemoteSessions?: ScanRemoteSessions
}

export class AiVaultHandler {
  private readonly remoteHome: string
  private readonly hostPlatform: RemoteHostPlatform
  private readonly scanRemoteSessions: ScanRemoteSessions
  private readonly provider: RemoteSessionFilesystemProvider
  private readonly scanCoordinator = new AiVaultScanCoordinator()

  constructor(dispatcher: RelayDispatcher, options: AiVaultHandlerOptions = {}) {
    this.remoteHome = options.remoteHome ?? homedir()
    this.hostPlatform = options.hostPlatform ?? currentRelayHostPlatform()
    this.scanRemoteSessions = options.scanRemoteSessions ?? scanRemoteAiVaultSessions
    this.provider = createRelayAiVaultFilesystemProvider()
    dispatcher.onRequest(SSH_AI_VAULT_LIST_SESSIONS_METHOD, (params, context) =>
      this.listSessions(params, context.signal)
    )
  }

  private async listSessions(
    rawParams: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AiVaultListResult> {
    const params = normalizeSshAiVaultRelayListParams(rawParams)
    const result = await this.scanCoordinator.run({
      key: JSON.stringify(params),
      signal,
      start: (scanSignal) =>
        this.scanRemoteSessions({
          provider: this.provider,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          remoteHome: this.remoteHome,
          hostPlatform: this.hostPlatform,
          limit: params.limit,
          scopePaths: params.scopePaths,
          signal: scanSignal
        })
    })
    if (!params.scopePathsTruncated) {
      return result
    }
    return {
      ...result,
      issues: [
        ...result.issues,
        {
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          agent: 'codex',
          kind: 'scope',
          path: this.remoteHome,
          message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
        }
      ]
    }
  }
}

export function normalizeSshAiVaultRelayListParams(
  params: Record<string, unknown>
): SshAiVaultRelayListParams {
  const rawLimit = params.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SSH_AI_VAULT_LIST_LIMIT_MAX)
      : undefined
  const scopePaths = Array.isArray(params.scopePaths)
    ? params.scopePaths
        .slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
        .filter(
          (path): path is string =>
            typeof path === 'string' &&
            path.trim().length > 0 &&
            path.length <= SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH
        )
    : undefined
  const scopePathsTruncated =
    params.scopePathsTruncated === true ||
    (Array.isArray(params.scopePaths) && params.scopePaths.length > AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(scopePaths === undefined ? {} : { scopePaths }),
    ...(scopePathsTruncated ? { scopePathsTruncated: true } : {})
  }
}

function currentRelayHostPlatform(): RemoteHostPlatform {
  const relayPlatform = parseUnameToRelayPlatform(process.platform, process.arch)
  if (!relayPlatform) {
    throw new Error(`Unsupported relay platform: ${process.platform}-${process.arch}`)
  }
  return getRemoteHostPlatform(relayPlatform)
}

function createRelayAiVaultFilesystemProvider(): RemoteSessionFilesystemProvider {
  return {
    async readDir(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    },
    readFile: readRelayFileContent,
    async stat(filePath) {
      const stats = await lstat(filePath)
      return {
        size: stats.size,
        type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
        mtime: stats.mtimeMs,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        nlink: stats.nlink
      }
    }
  }
}
