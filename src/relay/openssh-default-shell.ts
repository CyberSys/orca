import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const OPENSSH_REGISTRY_KEY = 'HKLM\\SOFTWARE\\OpenSSH'
const QUERY_TIMEOUT_MS = 3000
// Why: a failed probe must stay retryable, but a relay admitting a burst of PTY
// spawns must not re-run reg.exe once per spawn while the failure persists.
export const OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS = 30_000

/**
 * Three distinct outcomes, deliberately not collapsed into `''`:
 * - `undefined` — never probed.
 * - `resolved` — the registry answered; `shell` is `''` when no DefaultShell is set.
 *   Cached for the process lifetime, same as before.
 * - `failed` — the probe itself failed. Suppresses re-probing only until `retryAtMs`,
 *   so one transient registry error cannot permanently stop honoring the host's
 *   configured OpenSSH shell.
 */
type DefaultShellProbe =
  | { readonly kind: 'resolved'; readonly shell: string }
  | { readonly kind: 'failed'; readonly retryAtMs: number }

let probe: DefaultShellProbe | undefined
let inFlight: Promise<string> | undefined

async function queryDefaultShell(): Promise<string> {
  const { stdout } = await execFile(
    'reg.exe',
    ['query', OPENSSH_REGISTRY_KEY, '/v', 'DefaultShell'],
    { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, windowsHide: true }
  )
  const match = stdout.match(/^\s*DefaultShell\s+REG_\w+\s+(.+?)\s*$/im)
  return match?.[1] ?? ''
}

/**
 * Read the OpenSSH `DefaultShell` registry value, or `''` when none is set or the
 * probe is in its post-failure cooldown. Async so a slow registry read cannot stall
 * the relay's event loop.
 */
export async function readOpenSshDefaultShell(): Promise<string> {
  if (probe?.kind === 'resolved') {
    return probe.shell
  }
  if (probe?.kind === 'failed' && Date.now() < probe.retryAtMs) {
    return ''
  }
  // Why: share one in-flight probe so concurrent spawns don't each launch reg.exe.
  inFlight ??= queryDefaultShell()
    .then((shell) => {
      probe = { kind: 'resolved', shell }
      return shell
    })
    .catch(() => {
      probe = { kind: 'failed', retryAtMs: Date.now() + OPENSSH_DEFAULT_SHELL_RETRY_COOLDOWN_MS }
      return ''
    })
    .finally(() => {
      inFlight = undefined
    })

  return inFlight
}
