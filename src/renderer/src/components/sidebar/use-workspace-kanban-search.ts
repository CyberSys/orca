import { useCallback, useMemo, useState } from 'react'
import type { Repo, Worktree } from '../../../../shared/types'
import { matchWorkspaceBoardWorktrees } from './workspace-kanban-search'

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

  const matchingWorktreeIds = useMemo(
    () =>
      matchWorkspaceBoardWorktrees({
        worktrees: args.worktrees,
        query,
        repoMap: args.repoMap
      }),
    [args.repoMap, args.worktrees, query]
  )

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
