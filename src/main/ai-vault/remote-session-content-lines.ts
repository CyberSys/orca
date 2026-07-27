import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { throwIfRemoteSessionScanCancelled } from './remote-session-scan-cancellation'

const REMOTE_CONTENT_YIELD_LINE_COUNT = 200
const REMOTE_CONTENT_YIELD_CHAR_COUNT = 256 * 1024

export async function* remoteSessionContentLines(
  content: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  let lineStart = 0
  let yieldStart = 0
  let linesSinceYield = 0

  for (let index = 0; index <= content.length; index++) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield content.slice(lineStart, lineEnd)
    lineStart = index + 1
    linesSinceYield++
    if (
      linesSinceYield >= REMOTE_CONTENT_YIELD_LINE_COUNT ||
      index - yieldStart >= REMOTE_CONTENT_YIELD_CHAR_COUNT
    ) {
      throwIfRemoteSessionScanCancelled(signal)
      await yieldToEventLoop()
      throwIfRemoteSessionScanCancelled(signal)
      linesSinceYield = 0
      yieldStart = index
    }
  }
}
