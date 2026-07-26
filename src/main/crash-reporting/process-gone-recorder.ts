import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  sanitizeCrashReportString,
  type RendererSurface
} from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import {
  clearRetainedHighwaterBreadcrumbs,
  getCrashBreadcrumbSnapshot,
  restoreRetainedHighwaterBreadcrumbs
} from './crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
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

function processGoneBreadcrumbData(event: ProcessGoneCrashEvent) {
  return buildSuppressedProcessGoneBreadcrumbData(event)
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
function clearRetainedHighwatersForDeadRenderer(event: ProcessGoneCrashEvent): void {
  if (event.source !== 'renderer' || event.processType.toLowerCase() !== 'renderer') {
    return
  }
  // Why: only the main window wires process-gone today, so an unstamped event is its.
  clearRetainedHighwaterBreadcrumbs({ surface: event.rendererSurface ?? 'main' })
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
    recordDurableCrashBreadcrumb('process_gone_suppressed', processGoneBreadcrumbData(event))
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
  // Snapshot before the clear so the dying renderer's own report keeps its profiles.
  const breadcrumbs = getCrashBreadcrumbSnapshot()
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
      // Why: the retry re-snapshots, so without putting the cleared profiles back
      // the durable report it finally writes describes an OOM with no heap ladder.
      restoreRetainedHighwaterBreadcrumbs(breadcrumbs)
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
