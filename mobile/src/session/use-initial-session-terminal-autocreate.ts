import { useEffect, useRef, type MutableRefObject } from 'react'
import { shouldAutoCreateInitialSessionTerminal } from './initial-session-terminal'

type InitialSessionTerminalAutoCreateArgs = {
  client: unknown
  connState: string
  terminalsLoaded: boolean
  visibleTabCount: number
  activeHandle: string | null
  createInFlight: boolean
  /** Set once this route has published a non-empty tab list for the workspace. */
  sawSessionTabsRef: MutableRefObject<boolean>
  /** Worktree this route already auto-created for, or null. */
  autoCreatedForWorktreeRef: MutableRefObject<string | null>
  worktreeId: string
  createTerminal: () => void
}

/**
 * Creates the first terminal of a mobile session that hydrates with nothing to
 * show, at most once per workspace per route. Deliberately silent when the tab
 * list empties *after* being populated — see initial-session-terminal.
 */
export function useInitialSessionTerminalAutoCreate(
  args: InitialSessionTerminalAutoCreateArgs
): void {
  const {
    client,
    connState,
    terminalsLoaded,
    visibleTabCount,
    activeHandle,
    createInFlight,
    sawSessionTabsRef,
    autoCreatedForWorktreeRef,
    worktreeId
  } = args
  // Why: the route re-creates `createTerminal` every render; a ref keeps it out of the deps.
  const createTerminalRef = useRef(args.createTerminal)
  createTerminalRef.current = args.createTerminal

  useEffect(() => {
    if (
      !client ||
      !shouldAutoCreateInitialSessionTerminal({
        connected: connState === 'connected',
        tabsLoaded: terminalsLoaded,
        visibleTabCount,
        hasActiveTerminalHandle: activeHandle !== null,
        createInFlight,
        sawSessionTabs: sawSessionTabsRef.current,
        autoCreatedForWorktree: autoCreatedForWorktreeRef.current === worktreeId
      })
    ) {
      return
    }
    autoCreatedForWorktreeRef.current = worktreeId
    createTerminalRef.current()
  }, [
    activeHandle,
    autoCreatedForWorktreeRef,
    client,
    connState,
    createInFlight,
    sawSessionTabsRef,
    terminalsLoaded,
    visibleTabCount,
    worktreeId
  ])
}
