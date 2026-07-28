import { describe, expect, it } from 'vitest'
import {
  shouldAutoCreateInitialSessionTerminal,
  type InitialSessionTerminalAutoCreateInput
} from './initial-session-terminal'

function baseInput(
  overrides: Partial<InitialSessionTerminalAutoCreateInput> = {}
): InitialSessionTerminalAutoCreateInput {
  return {
    connected: true,
    tabsLoaded: true,
    visibleTabCount: 0,
    hasActiveTerminalHandle: false,
    createInFlight: false,
    sawSessionTabs: false,
    autoCreatedForWorktree: false,
    ...overrides
  }
}

/**
 * Replays the route state the session screen actually holds
 * (`app/h/[hostId]/session/[worktreeId].tsx`): `applySessionTabs` publishes the
 * tab list and flips `terminalsLoaded`, `handleCloseSessionTab` prunes the
 * closed tab and nulls the active handle.
 */
class SessionRouteState {
  tabsLoaded = false
  tabIds: string[] = []
  activeHandle: string | null = null
  sawSessionTabs = false
  autoCreatedForWorktree = false

  applySessionTabs(tabIds: string[], activeHandle: string | null = tabIds[0] ? 'pty-1' : null) {
    this.tabIds = tabIds
    this.activeHandle = activeHandle
    if (tabIds.length > 0) {
      this.sawSessionTabs = true
    }
    this.tabsLoaded = true
  }

  closeSessionTab(tabId: string) {
    this.tabIds = this.tabIds.filter((candidate) => candidate !== tabId)
    this.activeHandle = null
  }

  gate(): boolean {
    return shouldAutoCreateInitialSessionTerminal({
      connected: true,
      tabsLoaded: this.tabsLoaded,
      visibleTabCount: this.tabIds.length,
      hasActiveTerminalHandle: this.activeHandle !== null,
      createInFlight: false,
      sawSessionTabs: this.sawSessionTabs,
      autoCreatedForWorktree: this.autoCreatedForWorktree
    })
  }
}

describe('shouldAutoCreateInitialSessionTerminal', () => {
  it('creates the first terminal for a workspace that hydrates with nothing', () => {
    const route = new SessionRouteState()
    route.applySessionTabs([])
    expect(route.gate()).toBe(true)
  })

  it('does not re-create after the user closes the last tab (#9717, #7345)', () => {
    const route = new SessionRouteState()
    route.applySessionTabs(['tab-1'])
    expect(route.gate()).toBe(false)

    route.closeSessionTab('tab-1')
    expect(route.tabIds).toHaveLength(0)
    expect(route.activeHandle).toBeNull()
    // Emptiness that follows a populated list is a close, not a cold hydrate.
    expect(route.gate()).toBe(false)
  })

  it('does not re-create when the host drops every tab mid-session', () => {
    const route = new SessionRouteState()
    route.applySessionTabs(['tab-1', 'tab-2'])
    route.applySessionTabs([], null)
    expect(route.gate()).toBe(false)
  })

  it('stays armed while an empty workspace is still loading', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ tabsLoaded: false }))).toBe(false)
  })

  it('waits for the host connection', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ connected: false }))).toBe(false)
  })

  it('defers to a lagging snapshot that still has a streaming terminal', () => {
    expect(
      shouldAutoCreateInitialSessionTerminal(baseInput({ hasActiveTerminalHandle: true }))
    ).toBe(false)
  })

  it('does not stack a second create on an in-flight one', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ createInFlight: true }))).toBe(false)
  })

  it('fires at most once per workspace on this route', () => {
    expect(
      shouldAutoCreateInitialSessionTerminal(baseInput({ autoCreatedForWorktree: true }))
    ).toBe(false)
  })

  it('does not fire while tabs are visible', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ visibleTabCount: 2 }))).toBe(false)
  })
})
