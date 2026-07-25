import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: the sibling scheduler suite mocks exposeStore=true, so it cannot prove
// the backlog peaks and drop count survive in a production (non-e2e) build.
vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: false }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

function createTerminal() {
  return {
    element: { classList: { add: vi.fn(), remove: vi.fn() } },
    write: vi.fn(),
    refresh: vi.fn(),
    scrollToBottom: vi.fn(),
    buffer: { active: { viewportY: 0, baseY: 0 } },
    rows: 24,
    cols: 80
  } as never
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('terminalOutputQueue profile in production builds', () => {
  it('retains backlog peaks after the queue drains', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { writeTerminalOutput } = await import('./pane-terminal-output-scheduler')
    const { collectRendererMemoryProfileCounts } = await import('@/lib/renderer-memory-profile')

    writeTerminalOutput(createTerminal(), 'q'.repeat(32 * 1024), {
      foreground: false,
      latencySensitive: false
    })
    vi.advanceTimersByTime(1000)

    const counts = collectRendererMemoryProfileCounts()
    expect(counts['terminalOutputQueue.queuedChars']).toBe(0)
    expect(counts['terminalOutputQueue.peakQueuedCharsPerTerminal']).toBe(32 * 1024)
    expect(counts['terminalOutputQueue.peakTerminals']).toBe(1)
  })

  it('counts a dropped backlog', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { writeTerminalOutput } = await import('./pane-terminal-output-scheduler')
    const { collectRendererMemoryProfileCounts } = await import('@/lib/renderer-memory-profile')
    const terminal = createTerminal()

    for (let index = 0; index < 40; index += 1) {
      writeTerminalOutput(terminal, 'x'.repeat(1024 * 1024), {
        foreground: false,
        latencySensitive: false
      })
    }

    expect(
      collectRendererMemoryProfileCounts()['terminalOutputQueue.droppedBacklog']
    ).toBeGreaterThan(0)
  })
})
