import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData,
  type RendererSurface
} from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import {
  clearRetainedHighwaterBreadcrumbs,
  getCrashBreadcrumbSnapshot,
  mergeRetainedHighwaterBreadcrumbs
} from './crash-breadcrumb-store'
import {
  carryHighwaterBreadcrumbsForRetry,
  takeCarriedHighwaterBreadcrumbs
} from './process-gone-highwater-carryover'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from './durable-crash-breadcrumb'
import {
  shouldRecordProcessGoneCrash,
  type ExpectedTeardownScope,
  type ProcessGoneSource
} from './process-gone-classification'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData
} from './process-gone-diagnostics'
import {
  getProcessGoneDedupeKey,
  processGoneDedupe,
  type ProcessGoneDedupe
} from './process-gone-dedupe'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
  /** Which renderer surface died; scopes the retained heap-profile clear. */
  rendererSurface?: RendererSurface
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record'>

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

function processGoneBreadcrumbData(event: ProcessGoneCrashEvent) {
  return buildSuppressedProcessGoneBreadcrumbData(event)
}

// Why: key off the emitted breadcrumb, not the crash-report dedupe key, so two
// different recoverable services can never suppress each other's evidence.
function suppressedProcessGoneCoalesceKey(data: CrashReportBreadcrumbData): string {
  return JSON.stringify([
    data.source,
    data.processType,
    data.reason,
    data.exitCode,
    data.expectedTeardown,
    data.serviceName ?? null,
    data.name ?? null,
    data.type ?? null
  ])
}

function persistFailureData(event: ProcessGoneCrashEvent, error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    ...processGoneBreadcrumbData(event),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: sanitizeCrashReportString(error instanceof Error ? error.message : String(error)),
    ...(errorCode ? { errorCode } : {})
  }
}

/**
 * Why: a renderer generation ends whether or not a report is written — a
 * suppressed reload or SIGTERM kill replaces the process just the same, and the
 * successor re-arms its own ladder from zero. Only a real process death counts:
 * React error-boundary reports share source 'renderer' with no process gone.
 */
function deadRendererSurface(event: ProcessGoneCrashEvent): RendererSurface | undefined {
  if (event.source !== 'renderer' || event.processType.toLowerCase() !== 'renderer') {
    return undefined
  }
  // Why: only the main window wires process-gone today, so an unstamped event is its.
  return event.rendererSurface ?? 'main'
}

function clearRetainedHighwatersForDeadRenderer(event: ProcessGoneCrashEvent): void {
  const surface = deadRendererSurface(event)
  if (!surface) {
    return
  }
  clearRetainedHighwaterBreadcrumbs({ surface })
}

export function recordProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe = processGoneDedupe
): void {
  if (!isCrashReportReason(event.reason)) {
    clearRetainedHighwatersForDeadRenderer(event)
    return
  }
  if (
    !shouldRecordProcessGoneCrash({
      source: event.source,
      processType: event.processType,
      serviceName:
        typeof event.details.serviceName === 'string' ? event.details.serviceName : undefined,
      reason: event.reason,
      exitCode: event.exitCode,
      expectedTeardown: event.expectedTeardown
    })
  ) {
    // Why: Chromium can crash-loop a recoverable child (network service seen at
    // 1459/min) and each suppressed event costs a span plus a forced disk flush,
    // which both floods the 30-entry ring and evicts the real pre-crash trail.
    const suppressedData = processGoneBreadcrumbData(event)
    recordCoalescedDurableCrashBreadcrumb({
      name: 'process_gone_suppressed',
      data: suppressedData,
      coalesceKey: suppressedProcessGoneCoalesceKey(suppressedData),
      minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS
    })
    clearRetainedHighwatersForDeadRenderer(event)
    return
  }
  if (!store) {
    recordDurableCrashBreadcrumb(
      'crash_report_store_unavailable',
      processGoneBreadcrumbData(event),
      'Crash report store unavailable'
    )
    clearRetainedHighwatersForDeadRenderer(event)
    return
  }

  const key = getProcessGoneDedupeKey(event.source, event.processType, event.reason, event.exitCode)
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  const mainProcessLifecycle = getMainProcessLifecycleIdentity()
  const crashDetails = buildProcessGoneCrashDetails({
    ...event.details,
    ...mainProcessLifecycle
  })
  const surface = deadRendererSurface(event)
  // Snapshot before the clear so the dying renderer's own report keeps its profiles.
  const breadcrumbs = mergeRetainedHighwaterBreadcrumbs(
    getCrashBreadcrumbSnapshot(),
    takeCarriedHighwaterBreadcrumbs(key, { surface })
  )
  clearRetainedHighwatersForDeadRenderer(event)
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': event.source,
      'crash.process_type': event.processType,
      'crash.reason': event.reason,
      ...(event.exitCode !== null ? { 'crash.exit_code': event.exitCode } : {}),
      'app.version': app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      'app.main_process.pid': mainProcessLifecycle.mainProcessPid,
      'app.main_process.launch_id': mainProcessLifecycle.mainProcessLaunchId,
      'app.main_process.started_at': mainProcessLifecycle.mainProcessStartedAt,
      details: crashDetails,
      breadcrumbs
    }
  })
  // Why: a renderer crash can be followed by another process exit before the
  // trace batch window closes, so make the primary signal durable immediately.
  span.fail(
    `${event.source} process gone: ${event.processType} ${event.reason} (${event.exitCode ?? 'unknown'})`
  )
  flushActiveSink()

  void store
    .record({
      source: event.source,
      processType: event.processType,
      reason: event.reason,
      exitCode: event.exitCode,
      appVersion: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      details: crashDetails,
      breadcrumbs
    })
    .catch((error) => {
      // Why: the retry re-snapshots after the clear, so hand it this attempt's
      // profiles — otherwise the durable report it writes has no heap ladder.
      carryHighwaterBreadcrumbsForRetry(key, breadcrumbs, { surface })
      dedupe.release(claim)
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`
      )
    })
}
