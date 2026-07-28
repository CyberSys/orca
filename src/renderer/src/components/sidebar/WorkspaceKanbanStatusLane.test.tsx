// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./WorkspaceKanbanCard', () => ({
  default: ({ worktree }: { worktree: Worktree }) => (
    <div data-workspace-board-card-id={worktree.id} />
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

const status = { id: 'todo', label: 'Todo' }
const repoMap = new Map<string, Repo>()

function worktree(id: string): Worktree {
  return { id, repoId: 'repo-a', displayName: id } as Worktree
}

let container: HTMLDivElement
let root: Root

function renderLane(props: {
  items: Worktree[]
  totalCount: number
  hasQuery: boolean
  fullWorktreeIds?: string[]
}): void {
  act(() => {
    root.render(
      <WorkspaceKanbanStatusLane
        status={status}
        items={props.items}
        totalCount={props.totalCount}
        hasQuery={props.hasQuery}
        fullWorktreeIds={props.fullWorktreeIds}
        repoMap={repoMap}
        activeWorktreeId={null}
        columnWidth={308}
        isResizingColumn={false}
        isDragTarget={false}
        canCreateWorktree={true}
        selectedWorktreeIds={new Set()}
        selectedWorktrees={[]}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
        onActivate={vi.fn()}
        onSelectionGesture={vi.fn(() => false)}
        onContextMenuSelect={vi.fn(() => [])}
        onCreateWorktree={vi.fn()}
        onColumnResizeStart={vi.fn()}
        onColumnResizeKeyDown={vi.fn()}
      />
    )
  })
}

function lane(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-workspace-status-drop-target]')
  if (!element) {
    throw new Error('lane not rendered')
  }
  return element
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('WorkspaceKanbanStatusLane', () => {
  it('shows a plain count without a query and a matches/total count with one', () => {
    renderLane({ items: [worktree('a'), worktree('b')], totalCount: 2, hasQuery: false })
    expect(container.textContent).toContain('2')
    expect(container.textContent).not.toContain('2 / 2')

    renderLane({ items: [worktree('a')], totalCount: 5, hasQuery: true })
    expect(container.textContent).toContain('1 / 5')
  })

  it('keeps a fully filtered lane as a labeled drop target', () => {
    renderLane({ items: [], totalCount: 5, hasQuery: true })

    expect(container.textContent).toContain('No matches')
    expect(lane().hasAttribute('data-workspace-status-drop-target')).toBe(true)
  })

  it('shows the empty placeholder when there is no query', () => {
    renderLane({ items: [], totalCount: 0, hasQuery: false })

    expect(container.textContent).toContain('Empty')
    expect(container.textContent).not.toContain('No matches')
  })

  it('publishes the full lane membership even when the rendered set is a subset', () => {
    renderLane({
      items: [worktree('b')],
      totalCount: 3,
      hasQuery: true,
      fullWorktreeIds: ['a', 'b', 'c']
    })

    expect(lane().dataset.workspaceLaneFullIds).toBe('a\nb\nc')
    expect(container.querySelectorAll('[data-workspace-board-card-id]')).toHaveLength(1)
  })
})
