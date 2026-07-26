import type { CrashReportBreadcrumb } from '../../shared/crash-reporting'
import { filterRetainedHighwaterBreadcrumbs } from './crash-breadcrumb-store'
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

const carriedByDedupeKey = new Map<string, CarriedHighwaters>()

function prune(now: number): void {
  for (const [key, entry] of carriedByDedupeKey) {
    if (now - entry.stashedAt >= CARRYOVER_TTL_MS) {
      carriedByDedupeKey.delete(key)
    }
  }
  while (carriedByDedupeKey.size > MAX_CARRYOVER_KEYS) {
    const oldest = carriedByDedupeKey.keys().next()
    if (oldest.done) {
      break
    }
    carriedByDedupeKey.delete(oldest.value)
  }
}

/**
 * Why: process-gone clears retained profiles eagerly so the replacement renderer
 * starts clean, but a failed persist releases the dedupe claim for a retry — and
 * the retry re-snapshots. Stash the profiles against the claim's key so only that
 * retry can pick them up.
 */
export function carryHighwaterBreadcrumbsForRetry(
  key: string,
  breadcrumbs: CrashReportBreadcrumb[],
  now = Date.now()
): void {
  const highwaters = filterRetainedHighwaterBreadcrumbs(breadcrumbs)
  prune(now)
  carriedByDedupeKey.delete(key)
  if (highwaters.length === 0) {
    return
  }
  carriedByDedupeKey.set(key, { stashedAt: now, breadcrumbs: highwaters })
}

export function takeCarriedHighwaterBreadcrumbs(
  key: string,
  now = Date.now()
): CrashReportBreadcrumb[] {
  prune(now)
  const entry = carriedByDedupeKey.get(key)
  // Consume on read: a retry that succeeds must not re-arm the next generation.
  carriedByDedupeKey.delete(key)
  return entry?.breadcrumbs ?? []
}

export function clearCarriedHighwaterBreadcrumbsForTest(): void {
  carriedByDedupeKey.clear()
}
