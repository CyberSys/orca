export type PaneTerminalLifecycleCounts = {
  registered: number
  removed: number
  disposeErrors: number
}

let registeredPaneTerminals = 0
let removedPaneTerminals = 0
let terminalDisposeErrors = 0

export function recordPaneTerminalRegistered(): void {
  registeredPaneTerminals += 1
}

export function recordPaneTerminalRemoved(terminalDisposeFailed: boolean): void {
  removedPaneTerminals += 1
  if (terminalDisposeFailed) {
    terminalDisposeErrors += 1
  }
}

export function getPaneTerminalLifecycleCounts(): PaneTerminalLifecycleCounts {
  return {
    registered: registeredPaneTerminals,
    removed: removedPaneTerminals,
    disposeErrors: terminalDisposeErrors
  }
}

export function _resetPaneTerminalInstanceCensusForTests(): void {
  registeredPaneTerminals = 0
  removedPaneTerminals = 0
  terminalDisposeErrors = 0
}
