import { describe, expect, it } from 'vitest'
import { deriveCheckStatus } from './mappers'

describe('deriveCheckStatus', () => {
  it.each(['ERROR', 'STARTUP_FAILURE'])('treats %s as a failure', (conclusion) => {
    expect(deriveCheckStatus([{ status: 'COMPLETED', conclusion }])).toBe('failure')
  })
})
