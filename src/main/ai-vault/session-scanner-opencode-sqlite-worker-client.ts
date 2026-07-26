import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import {
  isOpenCodeSqliteScanTerminatedError,
  type OpenCodeSqliteScanContext
} from './session-scanner-opencode-sqlite-scan-context'
import type { OpenCodeSqliteListValue } from './session-scanner-opencode-sqlite-worker-protocol'
import {
  OpenCodeSqliteWorkerTransport,
  OpenCodeSqliteWorkerUnavailableError,
  type WorkerFactory
} from './session-scanner-opencode-sqlite-worker-transport'

export {
  IDLE_TEARDOWN_MS,
  MAX_CONSECUTIVE_DEATHS
} from './session-scanner-opencode-sqlite-worker-transport'
export type { WorkerFactory } from './session-scanner-opencode-sqlite-worker-transport'

export const LIST_TIMEOUT_MS = 30_000
export const PARSE_TIMEOUT_MS = 15_000

export class OpenCodeSqliteWorkerClient {
  private readonly transport: OpenCodeSqliteWorkerTransport

  constructor(options: { workerFactory: WorkerFactory; log?: (message: string) => void }) {
    this.transport = new OpenCodeSqliteWorkerTransport(options)
  }

  async list(args: {
    context: OpenCodeSqliteScanContext
    dbPaths: readonly string[]
    limit: number
    issues: AiVaultScanIssue[]
  }): Promise<SessionFileCandidate[]> {
    if (args.dbPaths.length === 0) {
      return []
    }
    try {
      const value = (await this.transport.dispatch(
        { kind: 'list', dbPaths: args.dbPaths, limit: args.limit },
        LIST_TIMEOUT_MS,
        args.context
      )) as OpenCodeSqliteListValue
      args.issues.push(...value.issues)
      return value.candidates
    } catch (err) {
      if (isOpenCodeSqliteScanTerminatedError(err)) {
        return []
      }
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        args.issues.push({
          agent: 'opencode',
          path: args.dbPaths[0] ?? 'opencode.db',
          message:
            'OpenCode history was skipped because its background scanner could not start; the app remains responsive.'
        })
        return []
      }
      args.issues.push({
        agent: 'opencode',
        path: args.dbPaths[0] ?? 'opencode.db',
        message: `OpenCode history scan did not complete: ${errorMessage(err)}`
      })
      return []
    }
  }

  async parse(args: {
    context: OpenCodeSqliteScanContext
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
  }): Promise<AiVaultSession | null> {
    try {
      const value = await this.transport.dispatch(
        { kind: 'parse', dbPath: args.dbPath, sessionId: args.sessionId, platform: args.platform },
        PARSE_TIMEOUT_MS,
        args.context
      )
      return value as AiVaultSession | null
    } catch (err) {
      if (isOpenCodeSqliteScanTerminatedError(err)) {
        throw err
      }
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        throw new Error('OpenCode SQLite background scanner could not start.')
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
}
