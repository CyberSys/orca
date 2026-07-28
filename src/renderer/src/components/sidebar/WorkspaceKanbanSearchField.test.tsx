// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceKanbanSearchField from './WorkspaceKanbanSearchField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onQueryChange = vi.fn()
const onClear = vi.fn()

function renderField(props: { query: string; matchCount?: number; totalCount?: number }): void {
  act(() => {
    root.render(
      <WorkspaceKanbanSearchField
        query={props.query}
        matchCount={props.matchCount ?? 0}
        totalCount={props.totalCount ?? 0}
        onQueryChange={onQueryChange}
        onClear={onClear}
      />
    )
  })
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input')
  if (!element) {
    throw new Error('field not rendered')
  }
  return element
}

function clearButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')
}

function liveRegion(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[aria-live="polite"]')
  if (!element) {
    throw new Error('live region not rendered')
  }
  return element
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('WorkspaceKanbanSearchField', () => {
  it('reports every keystroke without debouncing', () => {
    renderField({ query: '' })

    act(() => {
      // Why: React's value tracker shadows the `value` property, so a plain
      // assignment would look like a no-op and never fire onChange.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), 'or')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onQueryChange).toHaveBeenCalledWith('or')
  })

  it('only offers the clear affordance for a non-empty query', () => {
    renderField({ query: '' })
    expect(clearButton()).toBeNull()

    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    act(() => {
      clearButton()?.click()
    })

    expect(onClear).toHaveBeenCalledOnce()
  })

  it('hides the visual match count from assistive tech but keeps the clear button named', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })

    const count = container.querySelector('span[aria-hidden="true"]')
    expect(count?.textContent).toBe('3 / 12')
    expect(clearButton()?.getAttribute('aria-hidden')).toBeNull()
    expect(clearButton()?.getAttribute('aria-label')).toBe('Clear search')
  })

  it('announces match counts only after the query settles', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    expect(liveRegion().textContent).toBe('')

    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(liveRegion().textContent).toBe('3 of 12 workspaces match')

    renderField({ query: 'zzz', matchCount: 0, totalCount: 12 })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(liveRegion().textContent).toBe('No workspaces match')

    renderField({ query: '' })
    expect(liveRegion().textContent).toBe('')
  })

  it('clears a non-empty query on Escape and leaves an empty one to the drawer', () => {
    renderField({ query: 'orca', matchCount: 3, totalCount: 12 })
    // Why: React roots at `container`, so only a listener above it can observe
    // whether the field let Escape through.
    const bubbled = vi.fn()
    document.body.addEventListener('keydown', bubbled)

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(onClear).toHaveBeenCalledOnce()
    expect(bubbled).not.toHaveBeenCalled()

    renderField({ query: '' })
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(onClear).toHaveBeenCalledOnce()
    expect(bubbled).toHaveBeenCalledOnce()

    document.body.removeEventListener('keydown', bubbled)
  })
})
