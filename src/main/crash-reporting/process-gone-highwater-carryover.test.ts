import { afterEach, describe, expect, it } from 'vitest'
import type { CrashReportBreadcrumb, CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import {
  carryHighwaterBreadcrumbsForRetry,
  clearCarriedHighwaterBreadcrumbsForTest,
  takeCarriedHighwaterBreadcrumbs
} from './process-gone-highwater-carryover'

function breadcrumb(name: string, data?: CrashReportBreadcrumbData): CrashReportBreadcrumb {
  return { createdAt: '2026-07-25T12:00:00.000Z', name, data }
}

function highwater(thresholdPct: number): CrashReportBreadcrumb {
  return breadcrumb('renderer_memory_highwater', { rendererSurface: 'main', thresholdPct })
}

afterEach(() => {
  clearCarriedHighwaterBreadcrumbsForTest()
})

describe('process-gone highwater carryover', () => {
  it('carries only heap profiles to the matching key', () => {
    carryHighwaterBreadcrumbsForRetry(
      'renderer:renderer',
      [breadcrumb('app_started'), highwater(85)],
      1_000
    )

    expect(takeCarriedHighwaterBreadcrumbs('child:gpu', 1_000)).toEqual([])
    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', 1_000)).toEqual([highwater(85)])
  })

  it('consumes on read so a later crash starts clean', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], 1_000)

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', 1_000)).toHaveLength(1)
    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', 1_000)).toEqual([])
  })

  it('expires past the dedupe window', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], 1_000)

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', 3_000)).toEqual([])
  })

  it('replaces an earlier stash for the same key', () => {
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [highwater(85)], 1_000)
    carryHighwaterBreadcrumbsForRetry('renderer:renderer', [breadcrumb('app_started')], 1_500)

    expect(takeCarriedHighwaterBreadcrumbs('renderer:renderer', 1_500)).toEqual([])
  })

  it('bounds the key map', () => {
    for (let index = 0; index < 12; index += 1) {
      carryHighwaterBreadcrumbsForRetry(`child:service-${index}`, [highwater(85)], 1_000)
    }

    expect(takeCarriedHighwaterBreadcrumbs('child:service-0', 1_000)).toEqual([])
    expect(takeCarriedHighwaterBreadcrumbs('child:service-11', 1_000)).toHaveLength(1)
  })
})
