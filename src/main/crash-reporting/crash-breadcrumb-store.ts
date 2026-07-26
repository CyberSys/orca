import {
  sanitizeCrashReportBreadcrumbs,
  type CrashReportBreadcrumbData,
  type CrashReportBreadcrumb,
  type RendererSurface
} from '../../shared/crash-reporting'

const MAX_BREADCRUMBS = 30
// Why: retain all four thresholds for both renderer surfaces.
const MAX_RETAINED_BREADCRUMBS = 8
// Why: coalesceKey embeds an open-string agentType (length-trimmed only, never
// enum-checked), so the key space is unbounded over a long multi-agent/SSH session.
// Bound the coalesce map the same way ProcessGoneDedupe bounds its key map.
const MAX_COALESCE_KEYS = 128

let breadcrumbs: CrashReportBreadcrumb[] = []
let retainedBreadcrumbs = new Map<string, CrashReportBreadcrumb>()
let coalescedBreadcrumbs = new Map<string, { recordedAt: number; suppressed: number }>()

function retainedBreadcrumbKey(breadcrumb: CrashReportBreadcrumb): string | null {
  if (breadcrumb.name !== 'renderer_memory_highwater') {
    return null
  }
  const surface = breadcrumb.data?.rendererSurface
  const threshold = breadcrumb.data?.thresholdPct
  return `${breadcrumb.name}:${String(surface)}:${String(threshold)}`
}

function evictOldestRetainedBreadcrumbs(): void {
  while (retainedBreadcrumbs.size > MAX_RETAINED_BREADCRUMBS) {
    const oldestKey = retainedBreadcrumbs.keys().next()
    if (oldestKey.done) {
      break
    }
    retainedBreadcrumbs.delete(oldestKey.value)
  }
}

export function recordCrashBreadcrumb(name: string, data?: CrashReportBreadcrumbData): void {
  const sanitized = sanitizeCrashReportBreadcrumbs([
    {
      createdAt: new Date().toISOString(),
      name,
      data
    }
  ])
  const breadcrumb = sanitized?.[0]
  if (!breadcrumb) {
    return
  }
  const retainedKey = retainedBreadcrumbKey(breadcrumb)
  if (retainedKey) {
    retainedBreadcrumbs.delete(retainedKey)
    retainedBreadcrumbs.set(retainedKey, breadcrumb)
    evictOldestRetainedBreadcrumbs()
    return
  }
  breadcrumbs.push(breadcrumb)
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift()
  }
}

export function recordCoalescedCrashBreadcrumb({
  name,
  data,
  coalesceKey,
  minIntervalMs
}: {
  name: string
  data?: CrashReportBreadcrumbData
  coalesceKey: string
  minIntervalMs: number
}): { suppressedSinceLast: number } | undefined {
  const now = Date.now()
  const previous = coalescedBreadcrumbs.get(coalesceKey)
  if (previous && now - previous.recordedAt < minIntervalMs) {
    previous.suppressed += 1
    return undefined
  }

  // Drop entries past their suppression window (they can no longer coalesce
  // anything) and LRU-cap the rest. delete-then-set keeps insertion order =
  // recency so only genuinely idle keys are evicted.
  for (const [key, entry] of coalescedBreadcrumbs) {
    if (now - entry.recordedAt >= minIntervalMs) {
      coalescedBreadcrumbs.delete(key)
    }
  }
  coalescedBreadcrumbs.delete(coalesceKey)
  coalescedBreadcrumbs.set(coalesceKey, { recordedAt: now, suppressed: 0 })
  while (coalescedBreadcrumbs.size > MAX_COALESCE_KEYS) {
    const oldest = coalescedBreadcrumbs.keys().next()
    if (oldest.done) {
      break
    }
    coalescedBreadcrumbs.delete(oldest.value)
  }
  const suppressedSinceLast = previous?.suppressed ?? 0
  recordCrashBreadcrumb(name, suppressedSinceLast > 0 ? { ...data, suppressedSinceLast } : data)
  return { suppressedSinceLast }
}

/**
 * Which surface a retained profile belongs to, for the surface-scoped clear and
 * for the retry carryover that folds that clear back in.
 *
 * Why: an unattributed profile has no owner that could re-emit it, so the dying
 * renderer takes it rather than leaving it to poison the next report.
 */
export function ownsRetainedHighwaterBreadcrumb(
  breadcrumb: CrashReportBreadcrumb,
  surface: RendererSurface
): boolean {
  const breadcrumbSurface = breadcrumb.data?.rendererSurface
  return typeof breadcrumbSurface !== 'string' || breadcrumbSurface === surface
}

/**
 * Why: retained profiles are keyed by surface+threshold with no generation, and
 * a renderer reload resets the renderer-side one-shot guard while this store
 * survives. Without dropping them at process-gone, the next renderer's crash
 * inherits the dead one's heap profiles — reading as "OOM at a tiny heap".
 *
 * Scope the clear to the dead surface: a popout that outlives the main window
 * never re-emits its own profiles (its one-shot guard is still armed).
 */
export function clearRetainedHighwaterBreadcrumbs(options?: { surface?: RendererSurface }): void {
  const surface = options?.surface
  if (surface === undefined) {
    retainedBreadcrumbs.clear()
    return
  }
  for (const [key, breadcrumb] of retainedBreadcrumbs) {
    if (ownsRetainedHighwaterBreadcrumb(breadcrumb, surface)) {
      retainedBreadcrumbs.delete(key)
    }
  }
}

export function filterRetainedHighwaterBreadcrumbs(
  breadcrumbs: CrashReportBreadcrumb[]
): CrashReportBreadcrumb[] {
  return breadcrumbs
    .filter((breadcrumb) => retainedBreadcrumbKey(breadcrumb) !== null)
    .slice(-MAX_RETAINED_BREADCRUMBS)
}

/**
 * Why: a process-gone retry re-snapshots after the eager clear, so it must fold
 * the previous attempt's profiles back in. Lives here because only this module
 * knows the report budget: `sanitizeCrashReportBreadcrumbs` keeps the LAST 30
 * entries, and profiles are the oldest — appending blindly drops the ladder.
 */
export function mergeRetainedHighwaterBreadcrumbs(
  snapshot: CrashReportBreadcrumb[],
  carried: CrashReportBreadcrumb[]
): CrashReportBreadcrumb[] {
  const snapshotKeys = new Set(
    snapshot.map(retainedBreadcrumbKey).filter((key): key is string => key !== null)
  )
  // Why: anything the live store still holds for this key is the newer profile.
  const missing = filterRetainedHighwaterBreadcrumbs(carried).filter(
    (breadcrumb) => !snapshotKeys.has(String(retainedBreadcrumbKey(breadcrumb)))
  )
  if (missing.length === 0) {
    return snapshot
  }
  const retained = snapshot.filter((breadcrumb) => retainedBreadcrumbKey(breadcrumb) !== null)
  const recent = snapshot.filter((breadcrumb) => retainedBreadcrumbKey(breadcrumb) === null)
  const recentBudget = Math.max(0, MAX_BREADCRUMBS - retained.length - missing.length)
  return [...retained, ...missing, ...recent.slice(Math.max(0, recent.length - recentBudget))].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt)
  )
}

export function getCrashBreadcrumbSnapshot(): CrashReportBreadcrumb[] {
  // Why: long sessions must retain threshold profiles without growing the 30-entry budget.
  const retained = [...retainedBreadcrumbs.values()]
  const recent = breadcrumbs.slice(-(MAX_BREADCRUMBS - retained.length))
  return [...retained, ...recent]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((breadcrumb) => ({
      ...breadcrumb,
      ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {})
    }))
}

export function clearCrashBreadcrumbsForTest(): void {
  breadcrumbs = []
  retainedBreadcrumbs = new Map()
  coalescedBreadcrumbs = new Map()
}

export function getCoalescedKeyCountForTest(): number {
  return coalescedBreadcrumbs.size
}
