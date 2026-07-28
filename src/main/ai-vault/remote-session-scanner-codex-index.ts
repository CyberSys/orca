import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'
import { remoteSessionContentLines } from './remote-session-content-lines'
import { throwIfRemoteSessionScanCancelled } from './remote-session-scan-cancellation'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

export async function remoteCodexIndexTitles(args: {
  provider: RemoteSessionFilesystemProvider
  codexHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
  signal?: AbortSignal
}): Promise<Map<string, string>> {
  const cached = args.titleCaches.get(args.codexHome)
  if (cached) {
    return cached
  }
  const pending = readRemoteCodexIndexTitles(
    args.provider,
    args.codexHome,
    args.hostPlatform,
    args.signal
  )
  args.titleCaches.set(args.codexHome, pending)
  return pending
}

async function readRemoteCodexIndexTitles(
  provider: RemoteSessionFilesystemProvider,
  codexHome: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    throwIfRemoteSessionScanCancelled(signal)
    const { content, isBinary } = await provider.readFile(
      joinRemotePath(hostPlatform, codexHome, CODEX_SESSION_INDEX_FILE)
    )
    throwIfRemoteSessionScanCancelled(signal)
    if (isBinary) {
      return titleBySessionId
    }
    for await (const line of remoteSessionContentLines(content, signal)) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch {
    throwIfRemoteSessionScanCancelled(signal)
    // Codex indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
