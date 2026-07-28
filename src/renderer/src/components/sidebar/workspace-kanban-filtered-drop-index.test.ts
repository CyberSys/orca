import { describe, expect, it } from 'vitest'
import { resolveFullLaneDropIndex } from './workspace-kanban-filtered-drop-index'

const FULL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

describe('resolveFullLaneDropIndex', () => {
  it('is the identity when nothing is filtered', () => {
    for (let index = 0; index <= FULL.length; index++) {
      expect(
        resolveFullLaneDropIndex({
          fullLaneIds: FULL,
          renderedIds: FULL,
          filteredDropIndex: index
        })
      ).toBe(index)
    }
  })

  it('maps the first filtered slot onto the first match position', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['h'],
        filteredDropIndex: 0
      })
    ).toBe(7)
  })

  it('maps the end of a filtered lane one past the last match', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: 2
      })
    ).toBe(5)
  })

  it('maps a slot between two matches onto the following match', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e', 'g'],
        filteredDropIndex: 1
      })
    ).toBe(4)
  })

  it('handles a lane filtered to zero cards', () => {
    expect(
      resolveFullLaneDropIndex({ fullLaneIds: FULL, renderedIds: [], filteredDropIndex: 0 })
    ).toBe(0)
    expect(
      resolveFullLaneDropIndex({ fullLaneIds: FULL, renderedIds: [], filteredDropIndex: 3 })
    ).toBe(FULL.length)
  })

  it('falls back to the lane end when a rendered id is missing from the full lane', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['stale', 'e'],
        filteredDropIndex: 0
      })
    ).toBe(FULL.length)
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'stale'],
        filteredDropIndex: 2
      })
    ).toBe(FULL.length)
  })

  it('clamps out-of-range filtered indices to the first and last branches', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: -3
      })
    ).toBe(1)
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: 99
      })
    ).toBe(5)
  })
})
