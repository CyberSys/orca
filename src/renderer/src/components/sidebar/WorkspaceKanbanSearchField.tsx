import React, { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

const ANNOUNCE_DEBOUNCE_MS = 400

type WorkspaceKanbanSearchFieldProps = {
  query: string
  /** False for text that never narrows the board (whitespace-only, over-bound). */
  isFiltering: boolean
  matchCount: number
  totalCount: number
  onQueryChange: (query: string) => void
  onClear: () => void
}

function formatAnnouncement(matchCount: number, totalCount: number): string {
  return matchCount === 0
    ? translate(
        'auto.components.sidebar.WorkspaceKanbanSearchField.bdb753c78d',
        'No workspaces match'
      )
    : translate(
        'auto.components.sidebar.WorkspaceKanbanSearchField.4d96c209d6',
        '{{value0}} of {{value1}} workspaces match',
        { value0: matchCount, value1: totalCount }
      )
}

export default function WorkspaceKanbanSearchField({
  query,
  isFiltering,
  matchCount,
  totalCount,
  onQueryChange,
  onClear
}: WorkspaceKanbanSearchFieldProps): React.JSX.Element {
  const hasText = query !== ''
  const [announcement, setAnnouncement] = useState('')

  // Why: the filter itself is undebounced, but a polite live region that changes
  // on every keystroke produces continuous speech and makes the field unusable.
  useEffect(() => {
    if (!isFiltering) {
      setAnnouncement('')
      return
    }
    const timer = window.setTimeout(
      () => setAnnouncement(formatAnnouncement(matchCount, totalCount)),
      ANNOUNCE_DEBOUNCE_MS
    )
    return () => window.clearTimeout(timer)
  }, [isFiltering, matchCount, totalCount])

  return (
    <div className="relative flex min-w-0 flex-1 items-center max-w-[268px]">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
      <Input
        value={query}
        aria-label={translate(
          'auto.components.sidebar.WorkspaceKanbanSearchField.c0cd6bdf6c',
          'Search workspaces'
        )}
        placeholder={translate(
          'auto.components.sidebar.WorkspaceKanbanSearchField.49c266baaa',
          'Search'
        )}
        className={cn(
          'h-7 border-worktree-sidebar-border bg-background pl-7 text-xs',
          hasText && (isFiltering ? 'pr-16' : 'pr-8')
        )}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // Why: the board swallows Radix close requests, so an empty-field
          // Escape has nothing local to do and is left to bubble.
          if (event.key !== 'Escape' || !hasText) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          onClear()
        }}
      />
      {hasText ? (
        <div className="absolute right-1 flex items-center gap-0.5">
          {isFiltering ? (
            <span aria-hidden="true" className="text-[10px] text-muted-foreground">
              {matchCount} / {totalCount}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.sidebar.WorkspaceKanbanSearchField.3b7ea51793',
              'Clear search'
            )}
            onClick={onClear}
          >
            <X />
          </Button>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
