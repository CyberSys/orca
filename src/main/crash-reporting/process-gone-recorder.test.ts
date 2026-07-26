import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { clearCarriedHighwaterBreadcrumbsForTest } from './process-gone-highwater-carryover'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

type CapturingSink = TracerSink & { records: unknown[]; flushMock: ReturnType<typeof vi.fn> }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  const flushMock = vi.fn()
  return {
    records,
    flushMock,
    push: (record) => records.push(record),
    flush: flushMock,
    close: vi.fn()
  }
}

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

function highwatersIn(breadcrumbs: { name: string }[]): { name: string }[] {
  return breadcrumbs.filter((breadcrumb) => breadcrumb.name === 'renderer_memory_highwater')
}

function persistFailureCount(): number {
  return getCrashBreadcrumbSnapshot().filter(
    (breadcrumb) => breadcrumb.name === 'crash_report_persist_failed'
  ).length
}

function highwaterSurfaces(): unknown[] {
  return getCrashBreadcrumbSnapshot()
    .filter((breadcrumb) => breadcrumb.name === 'renderer_memory_highwater')
    .map((breadcrumb) => breadcrumb.data?.rendererSurface)
}

let sink: CapturingSink

beforeEach(() => {
  sink = capturingSink()
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
  clearCarriedHighwaterBreadcrumbsForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  clearCarriedHighwaterBreadcrumbsForTest()
})

describe('recordProcessGoneCrash', () => {
  it('durably records when the crash report store is unavailable', () => {
    recordProcessGoneCrash(null, event(), new ProcessGoneDedupe())

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'crash_report_store_unavailable',
        data: expect.objectContaining({
          source: 'renderer',
          expectedTeardown: 'none'
        })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('durably records why an expected renderer teardown was suppressed', () => {
    const record = vi.fn()

    recordProcessGoneCrash(
      { record } as never,
      event({ reason: 'killed', exitCode: 1, expectedTeardown: 'renderer-reload' }),
      new ProcessGoneDedupe()
    )

    expect(record).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ expectedTeardown: 'renderer-reload' })
      })
    ])
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          'breadcrumb.name': 'process_gone_suppressed'
        })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('coalesces a recoverable-service crash loop instead of flushing every event', () => {
    const record = vi.fn()
    const dedupe = new ProcessGoneDedupe()
    const networkServiceCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      expectedTeardown: 'none',
      details: { serviceName: 'network.mojom.NetworkService', type: 'Utility' }
    })

    // Observed peak in a real diagnostic bundle: 1459 suppressed crashes in one minute.
    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash({ record } as never, networkServiceCrash, dedupe)
    }

    expect(record).not.toHaveBeenCalled()
    expect(sink.records).toHaveLength(1)
    expect(sink.flushMock).toHaveBeenCalledOnce()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ serviceName: 'network.mojom.NetworkService' })
      })
    ])
  })

  it('keeps the pre-crash breadcrumb trail through a crash loop', () => {
    const dedupe = new ProcessGoneDedupe()
    recordCrashBreadcrumb('renderer_error', { message: 'boom' })

    for (let i = 0; i < 1_459; i++) {
      recordProcessGoneCrash(
        { record: vi.fn() } as never,
        event({
          source: 'child',
          processType: 'Utility',
          reason: 'crashed',
          details: { serviceName: 'network.mojom.NetworkService' }
        }),
        dedupe
      )
    }

    // Why: the ring holds 30 entries, so an uncoalesced loop evicts every real breadcrumb.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)).toEqual([
      'renderer_error',
      'process_gone_suppressed'
    ])
  })

  it('reports how many repeats a coalesced suppression stands for', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = event({
      source: 'child',
      processType: 'Utility',
      reason: 'crashed',
      details: { serviceName: 'network.mojom.NetworkService' }
    })
    const nowSpy = vi.spyOn(Date, 'now')

    nowSpy.mockReturnValue(0)
    for (let i = 0; i < 700; i++) {
      recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)
    }
    nowSpy.mockReturnValue(30_000)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash, dedupe)

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({ name: 'process_gone_suppressed' }),
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({ suppressedSinceLast: 699 })
      })
    ])
    // Why: the ring gets this count from the store itself, so only the span proves
    // the exported telemetry carries it too.
    expect(sink.records).toEqual([
      expect.objectContaining({ name: 'crash.breadcrumb' }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.data': expect.objectContaining({ suppressedSinceLast: 699 })
        })
      })
    ])
  })

  it('keeps suppressions with different exit codes separate', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (exitCode: number) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        exitCode,
        details: { serviceName: 'network.mojom.NetworkService' }
      })

    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(11), dedupe)
    recordProcessGoneCrash({ record: vi.fn() } as never, utilityCrash(139), dedupe)

    // Why: a clean shutdown code and a segfault are different failures; collapsing
    // them would hide the second behind the first for a full window.
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.exitCode)).toEqual([
      11, 139
    ])
  })

  it('never lets one recoverable service suppress another service evidence', () => {
    const dedupe = new ProcessGoneDedupe()
    const utilityCrash = (serviceName: string) =>
      event({
        source: 'child',
        processType: 'Utility',
        reason: 'crashed',
        details: { serviceName }
      })

    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('network.mojom.NetworkService'),
      dedupe
    )
    recordProcessGoneCrash(
      { record: vi.fn() } as never,
      utilityCrash('audio.mojom.AudioService'),
      dedupe
    )

    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.serviceName)).toEqual([
      'network.mojom.NetworkService',
      'audio.mojom.AudioService'
    ])
  })

  it('persists a report and flushes the process-gone trace before recovery', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'renderer',
        reason: 'crashed',
        exitCode: 5,
        details: expect.objectContaining({
          mainProcessPid: process.pid,
          mainProcessLaunchId: expect.any(String),
          mainProcessStartedAt: expect.any(String)
        })
      })
    )
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'electron.process_gone',
        attributes: expect.objectContaining({
          'app.main_process.pid': process.pid,
          'app.main_process.launch_id': expect.any(String),
          'app.main_process.started_at': expect.any(String)
        }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
    expect(sink.flushMock).toHaveBeenCalledOnce()
  })

  it('still persists the report when the forced trace flush fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.flushMock.mockImplementation(() => {
      throw new Error('trace disk unavailable')
    })

    expect(() =>
      recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('still persists the report when the trace sink handoff fails', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    sink.push = () => {
      throw new Error('trace rotation failed')
    }

    expect(() =>
      recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())
    ).not.toThrow()
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
  })

  it('durably records a sanitized crash-report persistence failure', async () => {
    const persistError = Object.assign(
      new Error('EPERM at C:\\Users\\alice\\AppData\\Roaming\\Orca\\crash-reports.json'),
      { code: 'EPERM' }
    )
    const record = vi.fn().mockRejectedValue(persistError)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() => {
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorCode: 'EPERM' })
          })
        ])
      )
    })
    expect(sink.records).toHaveLength(2)
    expect(sink.records[1]).toEqual(
      expect.objectContaining({
        name: 'crash.breadcrumb',
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
    expect(JSON.stringify(sink.records)).not.toContain('alice')
    expect(sink.flushMock).toHaveBeenCalledTimes(2)
  })

  it('keeps null persistence rejections inside the fail-open diagnostic path', async () => {
    const record = vi.fn().mockRejectedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'crash_report_persist_failed',
            data: expect.objectContaining({ errorName: 'object', errorMessage: 'null' })
          })
        ])
      )
    )
  })

  it('allows the same renderer crash to retry after persistence fails', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-2' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    recordProcessGoneCrash({ record } as never, event(), dedupe)
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
      )
    )
    recordProcessGoneCrash({ record } as never, event(), dedupe)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
  })

  // Why: retained profiles carry no renderer generation, so without this the
  // next renderer's bundle reports the dead one's heap as its own.
  it('does not carry a dead renderer high-water profile into the next crash', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85,
      usedHeapMB: 3586
    })

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    // The dying renderer's own bundle must still describe its heap.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        breadcrumbs: expect.arrayContaining([
          expect.objectContaining({ name: 'renderer_memory_highwater' })
        ])
      })
    )

    // A fresh renderer that dies before re-crossing must not inherit it.
    recordProcessGoneCrash({ record } as never, event({ exitCode: 9 }), new ProcessGoneDedupe())

    expect(getCrashBreadcrumbSnapshot()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'renderer_memory_highwater' })])
    )
  })

  // Why: a suppressed reload replaces the renderer just as a crash does, so the
  // successor would otherwise inherit the reloaded renderer's heap profiles.
  it('clears retained profiles on an expected renderer reload that writes no report', () => {
    const record = vi.fn()
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85,
      usedHeapMB: 3586
    })

    recordProcessGoneCrash(
      { record } as never,
      event({ reason: 'killed', exitCode: 15, expectedTeardown: 'renderer-reload' }),
      new ProcessGoneDedupe()
    )

    expect(record).not.toHaveBeenCalled()
    expect(highwaterSurfaces()).toEqual([])
  })

  it('clears retained profiles when the reason is not a crash-report reason', () => {
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85
    })

    recordProcessGoneCrash(null, event({ reason: 'clean-exit' }), new ProcessGoneDedupe())

    expect(highwaterSurfaces()).toEqual([])
  })

  // Why: React error-boundary reports travel this path with no process death.
  it('keeps retained profiles for a non-process renderer report', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85
    })

    recordProcessGoneCrash(
      { record } as never,
      event({ processType: 'react-render' }),
      new ProcessGoneDedupe()
    )

    expect(highwaterSurfaces()).toEqual(['main'])
  })

  // Why: the popout renderer is still alive and its one-shot guard stays armed,
  // so a wiped profile is never re-emitted for the rest of that session.
  it('does not wipe a live popout profile when the main renderer dies', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85
    })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'dashboard-popout',
      thresholdPct: 60
    })

    recordProcessGoneCrash({ record } as never, event(), new ProcessGoneDedupe())

    expect(highwaterSurfaces()).toEqual(['dashboard-popout'])
  })

  it('clears only the popout profile when the popout renderer dies', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85
    })
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'dashboard-popout',
      thresholdPct: 60
    })

    recordProcessGoneCrash(
      { record } as never,
      event({ rendererSurface: 'dashboard-popout' }),
      new ProcessGoneDedupe()
    )

    expect(highwaterSurfaces()).toEqual(['main'])
  })

  // Why: the eager clear runs before the async persist; a retry re-snapshots, so
  // a failed persist must hand the profiles on or the durable report loses the ladder.
  it('still reports the heap ladder when the retry follows a failed persist', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-2' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85,
      usedHeapMB: 3586
    })

    recordProcessGoneCrash({ record } as never, event(), dedupe)
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
      )
    )
    recordProcessGoneCrash({ record } as never, event(), dedupe)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(record.mock.calls[1][0].breadcrumbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'renderer_memory_highwater',
          data: expect.objectContaining({ usedHeapMB: 3586 })
        })
      ])
    )
  })

  // Why: the carryover is scoped to the retry, not to the key forever — a later
  // renderer generation reading "OOM at 3586MB" from a dead one is the bug the
  // eager clear exists to prevent.
  it('does not hand the ladder to a crash beyond the retry window', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-2' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const startedAt = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85,
      usedHeapMB: 3586
    })

    recordProcessGoneCrash({ record } as never, event(), dedupe)
    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'crash_report_persist_failed' })])
      )
    )
    now.mockReturnValue(startedAt + 60_000)
    recordProcessGoneCrash({ record } as never, event(), dedupe)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(
      record.mock.calls[1][0].breadcrumbs.filter(
        (breadcrumb: { name: string }) => breadcrumb.name === 'renderer_memory_highwater'
      )
    ).toEqual([])
  })

  // Why: the dedupe key omits the surface, so a popout dying the same way inside
  // the window claims the main window's stash — and inherits its ladder. Its own
  // failed persist must not evict that stash either: the main retry still needs it.
  it('holds the dead renderer stash for its own retry, not a sibling surface', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ id: 'report-3' })
    const dedupe = new ProcessGoneDedupe()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    recordCrashBreadcrumb('renderer_memory_highwater', {
      rendererSurface: 'main',
      thresholdPct: 85,
      usedHeapMB: 3586
    })

    recordProcessGoneCrash({ record } as never, event({ rendererSurface: 'main' }), dedupe)
    await vi.waitFor(() => expect(persistFailureCount()).toBe(1))
    recordProcessGoneCrash(
      { record } as never,
      event({ rendererSurface: 'dashboard-popout' }),
      dedupe
    )

    await vi.waitFor(() => expect(persistFailureCount()).toBe(2))
    expect(highwatersIn(record.mock.calls[1][0].breadcrumbs)).toEqual([])

    recordProcessGoneCrash({ record } as never, event({ rendererSurface: 'main' }), dedupe)

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3))
    expect(highwatersIn(record.mock.calls[2][0].breadcrumbs)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          rendererSurface: 'main',
          thresholdPct: 85,
          usedHeapMB: 3586
        })
      })
    ])
  })
})
