import { describe, expect, it, vi } from 'vitest'
import { applyGpuFallbackCommandLineSwitches } from './gpu-fallback-switches'

describe('GPU fallback command-line switches', () => {
  it('applies nothing outside Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const appendSwitch = vi.fn()
      expect(applyGpuFallbackCommandLineSwitches({ appendSwitch }, platform)).toEqual([])
      expect(appendSwitch).not.toHaveBeenCalled()
    }
  })

  // Why: measured on Windows 11 / Electron 43.1.0 — `--disable-gpu` alone still reports
  // GPU: 1 in app.getAppMetrics(); adding --in-process-gpu drops it to 0. And
  // --disable-software-rasterizer must stay absent: it kills SwiftShader, so
  // getContext('webgl2') returns null and every terminal drops to the DOM renderer.
  it('appends exactly the measured switch set to the Electron command line', () => {
    const appendSwitch = vi.fn()
    applyGpuFallbackCommandLineSwitches({ appendSwitch }, 'win32')
    expect(appendSwitch.mock.calls.map(([name]) => name)).toEqual(['disable-gpu', 'in-process-gpu'])
  })
})
