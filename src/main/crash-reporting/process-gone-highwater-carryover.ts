import type { CrashReportBreadcrumb, RendererSurface } from '../../shared/crash-reporting'
import {
  filterRetainedHighwaterBreadcrumbs,
  ownsRetainedHighwaterBreadcrumb
} from './crash-breadcrumb-store'
import { PROCESS_GONE_DEDUPE_WINDOW_MS } from './process-gone-dedupe'

// Why: a "retry" is a duplicate delivery of the same death, which Electron emits
// inside the dedupe window. Past it, the next claim is a different renderer
// generation and must not inherit a dead one's heap ladder.
const CARRYOVER_TTL_MS = PROCESS_GONE_DEDUPE_WINDOW_MS
const MAX_CARRYOVER_KEYS = 8

type CarriedHighwaters = {
  readonly stashedAt: number
  readonly breadcrumbs: CrashReportBreadcrumb[]
}

type CarryoverScope = { surface?: RendererSurface; now?: number }

const carriedByScopedKey = new Map<string, CarriedHighwaters>()

/**
 * Why: the dedupe key omits the surface, so a sibling surface dying the same way
 * shares it. Scope the stash key so the sibling neither reads our profiles nor
 * evicts them when its own persist fails.
 */
function carryoverKey(dedupeKey: string, surface: RendererSurface | undefined): string {
  return `${dedupeKey}\u0000${surface ?? ''}`
}

function prune(now: number): void {
  for (const [key, entry] of carriedByScopedKey) {
    if (now - entry.stashedAt >= CARRYOVER_TTL_MS) {
      carriedByScopedKey.delete(key)
    }
  }
  while (carriedByScopedKey.size > MAX_CARRYOVER_KEYS) {
    const oldest = carriedByScopedKey.keys().next()
    if (oldest.done) {
      break
    }
    carriedByScopedKey.delete(oldest.value)
  }
}

/**
 * Why: process-gone clears retained profiles eagerly so the replacement renderer
 * starts clean, but a failed persist releases the dedupe claim for a retry — and
 * the retry re-snapshots. Stash the profiles against the claim's key so only that
 * retry can pick them up.
 *
 * Scoped to the dying surface, mirroring the clear: only its own (and
 * unattributed) profiles went missing from the store, so re-seeding anything
 * else would resurrect a sibling surface's legitimately-cleared ladder.
 */
export function carryHighwaterBreadcrumbsForRetry(
  key: string,
  breadcrumbs: CrashReportBreadcrumb[],
  { surface, now = Date.now() }: CarryoverScope = {}
): void {
  const highwaters = filterRetainedHighwaterBreadcrumbs(breadcrumbs).filter(
    (breadcrumb) => surface === undefined || ownsRetainedHighwaterBreadcrumb(breadcrumb, surface)
  )
  const scopedKey = carryoverKey(key, surface)
  prune(now)
  carriedByScopedKey.delete(scopedKey)
  if (highwaters.length === 0) {
    return
  }
  carriedByScopedKey.set(scopedKey, { stashedAt: now, breadcrumbs: highwaters })
}

export function takeCarriedHighwaterBreadcrumbs(
  key: string,
  { surface, now = Date.now() }: CarryoverScope = {}
): CrashReportBreadcrumb[] {
  prune(now)
  const scopedKey = carryoverKey(key, surface)
  const entry = carriedByScopedKey.get(scopedKey)
  if (!entry) {
    return []
  }
  // Consume on read: a retry that succeeds must not re-arm the next generation.
  carriedByScopedKey.delete(scopedKey)
  return entry.breadcrumbs
}

export function clearCarriedHighwaterBreadcrumbsForTest(): void {
  carriedByScopedKey.clear()
}
