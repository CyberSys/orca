// Why: worktree ids embed repo paths, so commas and colons are unusable as a
// separator in the `data-workspace-lane-full-ids` channel; newlines are not.
export const WORKSPACE_LANE_FULL_IDS_DELIMITER = '\n'

/**
 * Returns `null` when the lane cannot be represented on this channel, so the
 * caller omits the attribute and the reader falls back to scanning cards.
 * Why: a newline is legal in a POSIX path, and joining over one would silently
 * split a single id into two phantom lane members.
 */
export function serializeWorkspaceLaneFullIds(worktreeIds: readonly string[]): string | null {
  if (worktreeIds.some((worktreeId) => worktreeId.includes(WORKSPACE_LANE_FULL_IDS_DELIMITER))) {
    return null
  }
  return worktreeIds.join(WORKSPACE_LANE_FULL_IDS_DELIMITER)
}

/** Returns `null` when the lane never published the attribute. */
export function parseWorkspaceLaneFullIds(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null
  }
  return value === '' ? [] : value.split(WORKSPACE_LANE_FULL_IDS_DELIMITER)
}

/**
 * Translates a drop index derived from the *rendered* cards of a lane onto the
 * lane's full membership. Board search hides non-matching cards, but manual-order
 * math runs against the full lane, so the two sides must be reconciled.
 *
 * Both id lists still contain the dragged ids — `getCardDropTarget` counts the
 * dragged card and `buildManualOrderUpdatesForGroupDrop` computes
 * `removedBeforeDrop` against the pre-removal group. Keep it that way.
 */
export function resolveFullLaneDropIndex(args: {
  fullLaneIds: readonly string[]
  renderedIds: readonly string[]
  filteredDropIndex: number
}): number {
  const { fullLaneIds, renderedIds, filteredDropIndex } = args
  // Why: equal lengths alone would take this branch for a stale DOM lane that
  // holds the same card count but different membership, skipping translation.
  if (isSameLane(fullLaneIds, renderedIds)) {
    return filteredDropIndex
  }
  if (renderedIds.length === 0) {
    return filteredDropIndex <= 0 ? 0 : fullLaneIds.length
  }

  if (filteredDropIndex <= 0) {
    return indexInFullLane(fullLaneIds, renderedIds[0]!)
  }
  if (filteredDropIndex >= renderedIds.length) {
    const lastIndex = indexInFullLane(fullLaneIds, renderedIds.at(-1)!)
    return Math.min(fullLaneIds.length, lastIndex + 1)
  }
  return indexInFullLane(fullLaneIds, renderedIds[filteredDropIndex]!)
}

function isSameLane(fullLaneIds: readonly string[], renderedIds: readonly string[]): boolean {
  return (
    renderedIds.length === fullLaneIds.length &&
    renderedIds.every((worktreeId, index) => worktreeId === fullLaneIds[index])
  )
}

// Why: a rendered id missing from the full lane is a stale-DOM race. Returning
// -1 would clamp to 0 downstream and teleport the card to the top of the lane.
function indexInFullLane(fullLaneIds: readonly string[], worktreeId: string): number {
  const index = fullLaneIds.indexOf(worktreeId)
  return index === -1 ? fullLaneIds.length : index
}
