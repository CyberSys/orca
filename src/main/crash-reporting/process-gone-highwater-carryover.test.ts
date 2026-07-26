import { afterEach, describe, expect, it } from 'vitest'
import type {
  CrashReportBreadcrumb,
  CrashReportBreadcrumbData,
  RendererSurface
} from '../../shared/crash-reporting'
import {
  carryHighwaterBreadcrumbsForRetry,
  clearCarriedHighwaterBreadcrumbsForTest,
  takeCarriedHighwaterBreadcrumbs
} from './process-gone-highwater-carryover'

function breadcrumb(name: string, data?: CrashReportBreadcrumbData): CrashReportBreadcrumb {
  return { createdAt: '2026-07-25T12:00:00.000Z', name, data }
}

function highwater(
  thresholdPct: number,
  rendererSurface: RendererSurface = 'main'
): CrashReportBreadcrumb {
  return breadcrumb('renderer_memory_highwater', { rendererSurface, thresholdPct })
}

afterEach(() => {
  clearCarriedHighwaterBreadcrumbsForTest()
})

describe('process-gone highwater carryover', () => {
  it('carries only heap profiles to the matching key', () => {
    carryHighwaterBreadcrumbsForRetry(
      'renderer:renderer',
      [breadcrumb('app_started'), highwater(85)],
      { now: 1_000 }
    )

    expect(takeCarriedHighwaterBreadcrumbs('child:gpu', { now: 1_000 })).toEqual([])
    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', { now: 1_000 })).toEqual([
      highwater(85)
    ])
  })

  it('consumes on read so a later crash starts clean', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], { now: 1_000 })

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', { now: 1_000 })).toHaveLength(1)
    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', { now: 1_000 })).toEqual([])
  })

  it('expires past the dedupe window', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], { now: 1_000 })

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', { now: 3_000 })).toEqual([])
  })

  it('replaces an earlier stash for the same key', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], { now: 1_000 })
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [breadcrumb('app_started')], {
      now: 1_500
    })

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', { now: 1_500 })).toEqual([])
  })

  it('carries only the dying surface (and unattributed) profiles', () => {
    const unattributed = breadcrumb('renderer_memory_highwater', { thresholdPct: 85 })
    carryHighwaterBreadcrumbsForRetry(
      'renderer:renderer',
      [highwater(85), highwater(90, 'dashboard-popout'), unattributed],
      { surface: 'main', now: 1_000 }
    )

    expect(
      takeCarriedHighwaterBreadcrumbs('renderer:renderer', { surface: 'main', now: 1_000 })
    ).toEqual([highwater(85), unattributed])
  })

  it('withholds the stash from a sibling surface sharing the dedupe key', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], {
      surface: 'main',
      now: 1_000
    })

    expect(
      takeCarriedHighwaterBreadcrumbs('renderer:renderer', {
        surface: 'dashboard-popout',
        now: 1_000
      })
    ).toEqual([])
    // The real retry still gets it.
    expect(
      takeCarriedHighwaterBreadcrumbs('renderer:renderer', { surface: 'main', now: 1_000 })
    ).toEqual([highwater(85)])
  })

  it('keeps each surface stash when a sibling shares the dedupe key', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], {
      surface: 'main',
      now: 1_000
    })
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(90, 'dashboard-popout')], {
      surface: 'dashboard-popout',
      now: 1_000
    })

    expect(
      takeCarriedHighwaterBreadcrumbs('renderer:renderer', {
        surface: 'dashboard-popout',
        now: 1_000
      })
    ).toEqual([highwater(90, 'dashboard-popout')])
    expect(
      takeCarriedHighwaterBreadcrumbs('renderer:renderer', { surface: 'main', now: 1_000 })
    ).toEqual([highwater(85)])
  })

  it('bounds the key map', () => {
    for (let index = 0; index < 12; index += 1) {
      carryHighwaterBreadcrumbsForRetry(`child:service-${index}`, [highwater(85)], { now: 1_000 })
    }

    expect(takeCarriedHighwaterBreadcrumbs('child:service-0', { now: 1_000 })).toEqual([])
    expect(takeCarriedHighwaterBreadcrumbs('child:service-11', { now: 1_000 })).toHaveLength(1)
  })
})
