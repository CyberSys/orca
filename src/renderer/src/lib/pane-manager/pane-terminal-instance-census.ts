import { registerRendererMemoryProfileContributor } from '../renderer-memory-profile'

// Why: `.xterm` element counts can't separate terminal churn from retention;
// counts climbing with worktree activations is the H1 signal. Caveat:
// disposePane increments disposed AND unmounts, so live-minus-mounted sees a
// created-but-never-disposed Terminal, never a disposed-but-retained one.
let createdPaneTerminals = 0
let disposedPaneTerminals = 0

export function recordPaneTerminalCreated(): void {
  createdPaneTerminals += 1
}

export function recordPaneTerminalDisposed(): void {
  disposedPaneTerminals += 1
}

export function _resetPaneTerminalInstanceCensusForTests(): void {
  createdPaneTerminals = 0
  disposedPaneTerminals = 0
}

registerRendererMemoryProfileContributor('paneTerminals', () => ({
  created: createdPaneTerminals,
  disposed: disposedPaneTerminals,
  live: createdPaneTerminals - disposedPaneTerminals
}))
