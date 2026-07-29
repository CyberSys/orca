import type { IDisposable, Terminal } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'

export const XTERM_COMPOSITION_SESSION_START_EVENT = 'xterm-composition-session-start'
export const XTERM_COMPOSITION_SESSION_END_EVENT = 'xterm-composition-session-end'

type CompositionSessionDetail = {
  id: number
  data?: string
}

type CapturedCompositionSession = {
  ptyId: string | null
}

function getCompositionDetail(event: Event): CompositionSessionDetail | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const detail = event.detail as Partial<CompositionSessionDetail> | null
  if (!detail || !Number.isSafeInteger(detail.id) || detail.id! <= 0) {
    return null
  }
  return {
    id: detail.id!,
    data: typeof detail.data === 'string' ? detail.data : undefined
  }
}

export function installTerminalImeCompositionRoute(args: {
  terminalElement: HTMLElement | null | undefined
  terminal: Pick<Terminal, 'input'>
  capturedTransport: PtyTransport
  getCurrentTransport: () => PtyTransport | undefined
}): IDisposable {
  const terminalElement = args.terminalElement
  const sessions = new Map<number, CapturedCompositionSession>()
  let disposed = false

  if (
    !terminalElement ||
    typeof terminalElement.addEventListener !== 'function' ||
    typeof terminalElement.removeEventListener !== 'function'
  ) {
    return { dispose: () => undefined }
  }

  const onSessionStart = (event: Event): void => {
    const detail = getCompositionDetail(event)
    if (!detail || disposed) {
      return
    }
    sessions.set(detail.id, {
      ptyId: args.capturedTransport.getPtyId()
    })
  }

  const onSessionEnd = (event: Event): void => {
    const detail = getCompositionDetail(event)
    if (!detail) {
      return
    }
    event.preventDefault()
    const captured = sessions.get(detail.id)
    if (!captured) {
      return
    }
    sessions.delete(detail.id)
    if (
      disposed ||
      !detail.data ||
      captured.ptyId === null ||
      args.getCurrentTransport() !== args.capturedTransport ||
      args.capturedTransport.getPtyId() !== captured.ptyId
    ) {
      return
    }
    args.terminal.input(detail.data)
  }

  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)

  return {
    dispose: () => {
      disposed = true
      sessions.clear()
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)
    }
  }
}
