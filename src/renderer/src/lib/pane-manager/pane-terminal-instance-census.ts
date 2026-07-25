import { registerRendererMemoryProfileContributor } from '../renderer-memory-profile'

/**
 * Created/disposed counts for pane xterm Terminal instances.
 *
 * Why: renderer_memory_highwater's `.xterm` element count only sees mounted
 * terminals. A disposed-but-retained (or never-disposed) Terminal pins its
 * buffer object graph in the V8 heap invisibly; live-minus-mounted in a crash
 * profile is the direct test for the detached-terminal leak hypothesis (C1).
 */
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
