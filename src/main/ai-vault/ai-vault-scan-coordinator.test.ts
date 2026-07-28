import { describe, expect, it, vi } from 'vitest'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'

const EMPTY_RESULT = { sessions: [], issues: [], scannedAt: '2026-07-27T00:00:00.000Z' }

describe('AiVaultScanCoordinator', () => {
  it('starts a fresh scan after every waiter cancels', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const signals: AbortSignal[] = []
    const start = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      if (signals.length > 1) {
        return Promise.resolve(EMPTY_RESULT)
      }
      return new Promise<typeof EMPTY_RESULT>((resolve) => {
        signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
      })
    })
    const controller = new AbortController()
    const first = coordinator.run({ key: 'scope', signal: controller.signal, start })
    await Promise.resolve()
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    const second = coordinator.run({ key: 'scope', start })

    await expect(second).resolves.toEqual(EMPTY_RESULT)
    expect(start).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)
  })
})
