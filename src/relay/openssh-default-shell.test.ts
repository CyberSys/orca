import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OpenSshDefaultShellModule from './openssh-default-shell'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

const POWERSHELL_7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function regOutput(value: string): string {
  return ['HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH', `    DefaultShell    REG_SZ    ${value}`].join(
    '\n'
  )
}

/** Drive the promisified execFile callback with a per-attempt outcome. */
function mockAttempts(outcomes: (string | Error)[]): { attempts: () => number } {
  let attempt = 0
  execFileMock.mockImplementation(
    (_command: string, _args: string[], _opts: unknown, cb: never) => {
      const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
      const outcome = outcomes[Math.min(attempt, outcomes.length - 1)]
      attempt += 1
      if (outcome instanceof Error) {
        callback(outcome, { stdout: '', stderr: '' })
        return
      }
      callback(null, { stdout: outcome, stderr: '' })
    }
  )
  return { attempts: () => attempt }
}

async function loadModule(): Promise<typeof OpenSshDefaultShellModule> {
  return import('./openssh-default-shell')
}

beforeEach(() => {
  vi.resetModules()
  execFileMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('readOpenSshDefaultShell', () => {
  it('reads and permanently caches a successful DefaultShell', async () => {
    const { attempts } = mockAttempts([regOutput(POWERSHELL_7)])
    const { readOpenSshDefaultShell } = await loadModule()

    expect(await readOpenSshDefaultShell()).toBe(POWERSHELL_7)
    expect(await readOpenSshDefaultShell()).toBe(POWERSHELL_7)
    expect(attempts()).toBe(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
      expect.any(Function)
    )
  })

  it('permanently caches a successful "no DefaultShell set" answer', async () => {
    // Why: a successful query that found nothing is authoritative — unlike a failed
    // query, re-probing it forever would be pure waste.
    const { attempts } = mockAttempts([
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShellCommandOption    REG_SZ    /c'
      ].join('\n')
    ])
    const { readOpenSshDefaultShell } = await loadModule()

    expect(await readOpenSshDefaultShell()).toBe('')
    expect(await readOpenSshDefaultShell()).toBe('')
    expect(attempts()).toBe(1)
  })

  it('retries after a transient failure and then returns the real DefaultShell', async () => {
    // REGRESSION: a single transient reg.exe error used to memoize '' for the
    // lifetime of the relay process, so the host's configured OpenSSH shell was
    // never honored again until restart.
    vi.useFakeTimers()
    const { attempts } = mockAttempts([new Error('reg.exe timed out'), regOutput(POWERSHELL_7)])
    const { readOpenSshDefaultShell, OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS } = await loadModule()

    expect(await readOpenSshDefaultShell()).toBe('')
    vi.advanceTimersByTime(OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS)

    expect(await readOpenSshDefaultShell()).toBe(POWERSHELL_7)
    expect(attempts()).toBe(2)
  })

  it('does not re-probe in a tight loop while a failure is still fresh', async () => {
    // Why: retryable must not mean "retried per PTY spawn" — a wedged reg.exe would
    // otherwise get a new subprocess for every spawn on the relay.
    vi.useFakeTimers()
    const { attempts } = mockAttempts([new Error('reg.exe failed')])
    const { readOpenSshDefaultShell, OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS } = await loadModule()

    expect(await readOpenSshDefaultShell()).toBe('')
    vi.advanceTimersByTime(OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS - 1)
    expect(await readOpenSshDefaultShell()).toBe('')
    expect(await readOpenSshDefaultShell()).toBe('')

    expect(attempts()).toBe(1)
  })

  it('shares one in-flight probe across concurrent callers', async () => {
    const { attempts } = mockAttempts([regOutput(POWERSHELL_7)])
    const { readOpenSshDefaultShell } = await loadModule()

    const results = await Promise.all([
      readOpenSshDefaultShell(),
      readOpenSshDefaultShell(),
      readOpenSshDefaultShell()
    ])

    expect(results).toEqual([POWERSHELL_7, POWERSHELL_7, POWERSHELL_7])
    expect(attempts()).toBe(1)
  })
})
