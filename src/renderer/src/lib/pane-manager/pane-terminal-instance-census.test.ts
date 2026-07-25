import { beforeEach, describe, expect, it } from 'vitest'
import { collectRendererMemoryProfileCounts } from '../renderer-memory-profile'
import {
  _resetPaneTerminalInstanceCensusForTests,
  recordPaneTerminalCreated,
  recordPaneTerminalDisposed
} from './pane-terminal-instance-census'

describe('pane terminal instance census', () => {
  beforeEach(() => {
    _resetPaneTerminalInstanceCensusForTests()
  })

  it('reports created/disposed/live counts through the memory profile registry', () => {
    recordPaneTerminalCreated()
    recordPaneTerminalCreated()
    recordPaneTerminalCreated()
    recordPaneTerminalDisposed()

    expect(collectRendererMemoryProfileCounts()).toEqual(
      expect.objectContaining({
        'paneTerminals.created': 3,
        'paneTerminals.disposed': 1,
        'paneTerminals.live': 2
      })
    )
  })
})
