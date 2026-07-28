import { useEffect, useReducer, useRef, type MutableRefObject } from 'react'
import { shouldAutoCreateInitialSessionTerminal } from './initial-session-terminal'

type InitialSessionTerminalAutoCreateState = {
  autoCreatedForWorktree: string | null
  sawSessionTabs: boolean
}

export function createInitialSessionAutoCreateState(): InitialSessionTerminalAutoCreateState {
  return { autoCreatedForWorktree: null, sawSessionTabs: false }
}

type InitialSessionTerminalAutoCreateArgs = {
  client: unknown
  newlyCreatedWorkspace: boolean
  connState: string
  terminalsLoaded: boolean
  visibleTabCount: number
  activeHandle: string | null
  createInFlight: boolean
  stateRef: MutableRefObject<InitialSessionTerminalAutoCreateState>
  worktreeId: string
  consumeCreationRoute: () => void
  createTerminal: () => void
}

/**
 * Creates the first terminal of a newly created mobile workspace that hydrates
 * empty, at most once per route. See initial-session-terminal.
 */
export function useInitialSessionTerminalAutoCreate(
  args: InitialSessionTerminalAutoCreateArgs
): void {
  const {
    client,
    newlyCreatedWorkspace,
    connState,
    terminalsLoaded,
    visibleTabCount,
    activeHandle,
    createInFlight,
    stateRef,
    worktreeId
  } = args
  const consumeCreationRouteRef = useRef(args.consumeCreationRoute)
  consumeCreationRouteRef.current = args.consumeCreationRoute
  // Why: the route re-creates `createTerminal` every render; a ref keeps it out of the deps.
  const createTerminalRef = useRef(args.createTerminal)
  createTerminalRef.current = args.createTerminal

  useEffect(() => {
    if (newlyCreatedWorkspace && terminalsLoaded) {
      consumeCreationRouteRef.current()
    }
    if (
      !client ||
      !shouldAutoCreateInitialSessionTerminal({
        newlyCreatedWorkspace,
        connected: connState === 'connected',
        tabsLoaded: terminalsLoaded,
        visibleTabCount,
        hasActiveTerminalHandle: activeHandle !== null,
        createInFlight,
        sawSessionTabs: stateRef.current.sawSessionTabs,
        autoCreatedForWorktree: stateRef.current.autoCreatedForWorktree === worktreeId
      })
    ) {
      return
    }
    stateRef.current.autoCreatedForWorktree = worktreeId
    createTerminalRef.current()
  }, [
    activeHandle,
    client,
    connState,
    createInFlight,
    newlyCreatedWorkspace,
    stateRef,
    terminalsLoaded,
    visibleTabCount,
    worktreeId
  ])
}

export function useWorktreeSessionTabsLoaded(
  worktreeId: string
): readonly [boolean, (loaded: boolean) => void] {
  const [loadedForWorktree, setLoaded] = useReducer(
    (_current: string | null, loaded: boolean) => (loaded ? worktreeId : null),
    null
  )
  return [loadedForWorktree === worktreeId, setLoaded]
}
