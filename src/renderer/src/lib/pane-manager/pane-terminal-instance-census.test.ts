import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPaneTerminalInstanceCensusForTests,
  getPaneTerminalLifecycleCounts,
  recordPaneTerminalRegistered,
  recordPaneTerminalRemoved
} from './pane-terminal-instance-census'

describe('pane terminal instance census', () => {
  beforeEach(() => {
    _resetPaneTerminalInstanceCensusForTests()
  })

  it('reports successful registrations, removals, and terminal disposal failures', () => {
    recordPaneTerminalRegistered()
    recordPaneTerminalRegistered()
    recordPaneTerminalRegistered()
    recordPaneTerminalRemoved(false)
    recordPaneTerminalRemoved(true)

    expect(getPaneTerminalLifecycleCounts()).toEqual({
      registered: 3,
      removed: 2,
      disposeErrors: 1
    })
  })
})
