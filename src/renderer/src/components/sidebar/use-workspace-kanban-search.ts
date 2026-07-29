import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import type { Repo, Worktree } from '../../../../shared/types'
import { matchWorkspaceBoardWorktrees } from './workspace-kanban-search'

function areWorktreeIdSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

export function useWorkspaceKanbanSearch(args: {
  open: boolean
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
}): {
  query: string
  setQuery: (query: string) => void
  clearQuery: () => void
  matchingWorktreeIds: ReadonlySet<string> | null
  hasQuery: boolean
} {
  const [query, setQuery] = useState('')

  // Why: a stale query silently hiding cards on reopen is a trap. Reset during
  // render like useWorkspaceKanbanSelection, so no frame paints the old filter.
  if (!args.open && query !== '') {
    setQuery('')
  }

  // Why: the input stays fully controlled and undebounced, but a query change
  // mounts or unmounts every hidden card — clearing one costs about what opening
  // the board costs. Deferring only the filter keeps the caret responsive and
  // lets React interrupt the board re-render.
  const deferredQuery = useDeferredValue(query)

  const matched = useMemo(
    () =>
      matchWorkspaceBoardWorktrees({
        worktrees: args.worktrees,
        query: deferredQuery,
        repoMap: args.repoMap
      }),
    [args.repoMap, args.worktrees, deferredQuery]
  )

  // Why: board identities churn on agent-status ticks, so an unchanged match set
  // must keep its identity or every memoized card re-renders on every tick.
  const stableMatchedRef = useRef<ReadonlySet<string> | null>(null)
  const previousMatched = stableMatchedRef.current
  const matchingWorktreeIds =
    previousMatched && matched && areWorktreeIdSetsEqual(previousMatched, matched)
      ? previousMatched
      : matched
  stableMatchedRef.current = matchingWorktreeIds

  const clearQuery = useCallback(() => setQuery(''), [])

  return {
    query,
    setQuery,
    clearQuery,
    matchingWorktreeIds,
    // Why: an over-bound query is non-empty but non-filtering, and the lane
    // counts must not switch to "n / m" for it.
    hasQuery: matchingWorktreeIds !== null
  }
}
