# C1 Diagnosis — Renderer JS heap leak to the 3586 MB V8 ceiling

Status: COMPLETE — measurement model corrected, root-cause candidate identified
(H1, high confidence on mechanism), instrumentation to confirm it in one field
cycle implemented in this branch (§6).

Corpus: the `fix-crashes-07-25` worktree's `.crash-triage/` bundle set (57 bundles, 2026-07-24 → 07-25).
All bundle re-derivations below were recomputed from the raw `.ndjson` files, not from digests.

---

## 1. New measurement-model findings (change how the field data must be read)

### 1.1 `performance.memory` in the field builds is bucketized AND cached for 20 minutes

Across all 57 bundles, `renderer_memory.usedHeapMB` takes only a small set of
discrete values spaced geometrically ~6% apart (e.g. …2356, 2499, 2661, 2823,
2995, 3185, 3376, 3586). `HI0BVrVVtVvf2gCRCpxYNg` has **19 distinct values in
1118 samples**. Consecutive-sample value changes cluster at ~20.4-minute gaps:
of 748 change-gaps corpus-wide, **580 sit in the 15–26 min band (mean 20.42
min)** and nearly all the rest at integer multiples of ~20 min.

This is Chromium's anti-fingerprinting `MemoryInfo` behavior: without
`--enable-precise-memory-info`, values are quantized into geometric buckets and
the quantized triple is **cached for 20 minutes**. Orca never passes that
switch (verified: no hit for `precise-memory-info` in `src/` at HEAD or
v1.4.155; renderer heap flags are set in
`src/main/startup/renderer-heap-headroom.ts:92-101` without it).

Consequences, corpus-wide:

- **Every published climb rate (4–127 MB/min) is a 20-minute-window average of
  ±3% bucketized values.** The true within-window shape (smooth drip vs.
  bursts vs. sawtooth) is unobservable in this corpus.
- "The trace is a clean monotone staircase — GC reclaims nothing" is partly a
  measurement artifact: any GC sawtooth shorter than 20 min is invisible.
  Multi-hour net growth to the ceiling still proves retention, but the
  "constant per-tick leak" inference is weaker than reported.
- **Any renderer younger than ~20 minutes reports its boot-time value (~26 MB)
  regardless of actual heap.** This further undermines C3's "oom kill at tiny
  heap" signature (deaths 4–35 s after bootstrap read the startup sample *by
  construction*), and softens C7's "kill at healthy heap" (values up to 20 min
  stale + bucketized).
- The `renderer_memory_highwater` gate at HEAD
  (`src/renderer/src/lib/crash-diagnostics.ts:131-175`) reads the same cached
  value, so in production **thresholds fire up to 20 minutes late**, and a
  fast climb (40+ MB/min) can blow through 0.6→0.8→death inside one or two
  cache windows. The contributor counts it emits are live, but the trigger
  timing and both threshold crossings can collapse into a single stale sample.

### 1.2 The per-cycle climb decelerates; the first 20 minutes are the fastest

`HI0BVrVVtVvf2gCRCpxYNg` (codeg-dev, darwin, 12 crash/reload cycles in
18.5 h): in a representative cycle the 20-min refresh sequence is 25 → 1745 →
2661 → 3185 → 3586 MB, i.e. per-window growth **+1720, +916, +524, +401 MB**
(~86 → 20 MB/min, roughly halving each window). Every one of the 12 cycles
shows the same front-loaded shape. So on this machine the renderer reaches
**~1.7 GB within 20 minutes of every boot**, immediately after
`renderer_recovery_reload` remounts the workspace.

Two readings (not mutually exclusive):
- Constant allocation with V8 GC working progressively harder as the heap
  approaches the cage (net rate declines near the limit), and/or
- A large retention burst tied to the boot/rehydration path (replay, initial
  hydration) plus a slower steady drip.

Precise-memory instrumentation (below) separates these in one field cycle.

### 1.3 The leak's driver lives outside the renderer

Twelve consecutive renderer processes on one machine each re-accumulated
~3.5 GB and died, over 18.5 h (largely overnight), with no user action
required between cycles: whatever feeds the leak survives
`renderer_recovery_reload`. The driver is main-process/daemon/agent-side
state (running agent CLIs streaming PTY output, pollers, runtime event
pushes, replayed scrollback) — the renderer is reborn fresh and re-leaks
immediately. (Note: the earlier "resumes at the *same rate*" phrasing is not
strictly measurable through a 20-min cache; what is proven is recurrence per
cycle without user interaction.) Any instrumentation targeting only
user-initiated actions will miss it.

### 1.4 Corpus correlates (recomputed per bundle)

| observation | value |
|---|---|
| OOM (≥2222 MB) bundles | 34, on darwin (24), win32 (8), linux (1) + 1 more darwin |
| Zero-instrumented-git OOM | `1biDRoyWW0olZvRB0m0_Hg` (darwin, 9.9 MB/min median, 543 samples, daemon logs present) |
| Heavy-git healthy | `W8XfXqvZe9L2Kb7t2fbSEA`: 8728 git execs in 2.6 h (56/min), peaks 228 MB |
| Fastest early climb | `PTjgxrVbLyEOfKYyDBOsOw` (win32, 107-repo C2 machine): ≥323 MB/min in first window |
| Webviews | 0–3 in nearly all OOM bundles (max 17 in a *healthy* one) — webviews don't correlate |
| `terminal_replay_guard_wedged_release` | concentrated in *healthy* bundles (31, 22, 17…), ~0–2 in OOM bundles — inverse correlation |

Confirms the FINAL_REPORT: git exec count/rate neither necessary nor
sufficient. The 32× between-machine rate spread with within-machine constancy
points at a per-session workload factor (active agent terminals × their output
rate is the leading candidate; see §2).

---

## 2. Ranked root-cause hypotheses

The corpus cannot name the accumulator (that is what the instrumentation in
§4/§6 is for), but code inventory narrows and ranks the candidates. A key
physical constraint: `usedJSHeapSize` counts V8-heap objects and strings, NOT
ArrayBuffer backing stores >64 B — so xterm scrollback row data (per-line
`Uint32Array`s) is mostly *invisible* to the metric that hit 3586 MB. The
3.5 GB is strings, plain objects, closures, and small-object graphs.

### H1 — Mounted-worktree retention policy: activated worktrees never unmount, and whole classes can never park (PRIMARY ROOT-CAUSE CANDIDATE)

Two independent code audits converged on this exact path at v1.4.155:

1. `Terminal.tsx:1018` — `mountedWorktreeIdsRef.current.add(...)` on **every**
   worktree activation, permanently. Removal (`:1031-1037`) happens only when
   the worktree ceases to exist. Both render paths (`:2124` legacy, `:2071`
   split) mount a live `<TerminalPane>` per tab for every id in that set;
   hidden worktrees get CSS `hidden` (`:2143`) but stay mounted, PTY-attached,
   and streaming into full-scrollback xterms.
2. The ONLY eviction lever is cold parking
   (`terminal-hidden-view-parking.ts`): 30 s hysteresis, 15-min hot-retain
   TTL, cap of 8 worktrees / 12 tabs. **But the cap and TTL apply only to
   worktrees that first qualify as parking candidates.**
   `canParkTerminalWorktreeRenderers` (`:70-108`) requires
   `isSnapshotBackedTerminalPty` (`:56-68`) for every tab — which returns
   false for: SSH-hosted ptys, remote-runtime ptys, null ptyIds
   (`ssh-target-cleanup.ts:105` sets exactly that), separator-less
   daemon-fail-open ids, ptys minted under a different worktreeId, plus
   worktrees with perpetually-pending startup/activation spawns. A worktree
   failing the filter is never ranked, never counted against the cap, never
   ages out: **unlimited retention as a side effect of being un-parkable.**
3. Even on the fully-eligible happy path, the cap of 8 was sized against a
   "~4-5 MB renderer floor each" estimate (comment at `:9-10`); with 5k
   default / 50k max scrollback rows and multiple agent tabs, a worktree
   clears 50 MB+ — the estimate is off by 1–2 orders of magnitude. The
   legacy (non-split) path additionally has NO per-tab parking at all
   (`Terminal.tsx:2148-2194`): one ineligible tab pins the whole worktree.
4. Disposal itself is clean: every actual-unmount path reaches
   `disposePane()`/`terminal.dispose()` and clears the scheduler's strong
   `Map<Terminal, …>` key (verified across tab close, generation bump,
   cold-park, worktree delete, split close, detach). The bug is retention
   policy, not teardown.

Exact leak path: `sidebar_worktree_activate` → permanent mount → user
switches away → parking evaluator rejects the worktree (or the cap of 8 never
fills for eligible ones) → its terminals stream all night into retained
hidden xterms → heap staircase; `renderer_recovery_reload` rehydrates the
same mounted set → identical climb next cycle. Matches every field
signature: ~250–450 MB steps against 7 activations in the zero-git SSH
bundle, overnight continuous climb while agent CLIs stream (codeg-dev, 12
cycles), 32× between-machine spread (worktree/tab count × scrollback ×
output rate), heavy-git-but-few-worktrees sessions staying healthy.

Magnitude caveat: xterm row payloads (per-line `Uint32Array`s >64 B) live
off-V8-heap, so the `usedJSHeapSize` cost per retained terminal is its JS
object graph (BufferLine objects, `_combined` maps, CircularList, parser
state, listeners) — plausibly 5–20 MB per big-scrollback terminal, needing
tens of retained streaming terminals for GB scale. The §6 instrumentation
measures exactly this.

**Falsify/confirm:** field — `paneTerminals.live` vs `terminalElements` and
precise heap shape on the next crash; repro — SSH workspace, activate 10+
worktrees with streaming tabs, switch away, watch precise heap (never
plateaus = confirmed).

**Fix direction** (not implemented here — behavioral change needing
coordination): make retention memory-bounded rather than eligibility-bounded.
Un-parkable worktrees should be evicted FIRST with a fallback teardown that
accepts snapshot-fidelity loss (SSH/remote panes already re-hydrate via their
own reattach path); at minimum, apply a hard cap on total mounted worktrees
BEFORE the parkability filter, and byte-weight the hot-retain budget.

### H2 — `pendingSideEffects`: the one genuinely uncapped hot-path queue

`pty-transport.ts:157` (v1.4.155): `pendingSideEffects: PendingPtySideEffect[]`
has **no length cap**. One entry per OSC title / payload / bell / stale-probe
per chunk; drained 64 per `setTimeout(0)` tick — and a backgrounded document
clamps that timer to ~1 Hz, so the drain ceiling is ~64 entries/s while fill
is unbounded (the code's own comment at `:365`: "thousands of queued OSC
facts can pile up under timer throttling"). Worse, `pausePendingSideEffects`
(`:455-458`) cancels the drain timer **without clearing the queue**. Agent
TUIs repaint OSC titles continuously; a minimized overnight window with many
agent panes (the codeg-dev profile) fills faster than it drains — small
objects plus title strings, steadily, forever. Survives reload, passive,
scales per-machine.

**Falsify/confirm:** the `ptySideEffects.pending`/`processors` contributor
(now implemented in §6: gauge = `pendingSideEffects.length -
pendingSideEffectIndex` per live output processor, registered at processor
create, disposed on transport `detach()`/`destroy()`) reports outstanding
queue depth at every highwater crossing. Repro: background the window, run 10
agent panes emitting title changes, watch precise heap.

### H3 — Remote-flow parse-backpressure hole, fixed by #10012 (NOT in 1.4.152/155)

`72a2d7bc7d` ("fix(terminal): bound parse-deferred remote flow", #10012,
2026-07-22) is in HEAD but **not** in v1.4.152 or v1.4.155. Its renderer half
(`src/renderer/src/lib/pane-manager/terminal-delivery-credit.ts`) fixes this
defect present in the field builds: a PTY delivery that split into multiple
scheduler writes settled its ACK credit after the **first** write parsed
("only the FIRST scheduler write of a delivery carries the credit" — v155
comment at `terminal-pty-ack-gate.ts:106`), instead of after *all* writes.
Premature credit refills the sender's flow-control window while the renderer
is still parsing, so a sustained fast stream can outrun the parser and the
un-parsed remainder accumulates renderer-side. The invariant text added by
the fix says it directly: credit must settle exactly once per delivery "so
streams neither leak memory nor stall"; "receipt-time ACK is forbidden."

Fit with the field data: passive (agent CLIs streaming), driver survives
renderer reload (the remote PTY keeps producing), rate scales with per-machine
agent output volume (32× spread), invisible to breadcrumbs, and consistent
with the zero-git OOM bundle (`1biDRoy…` — SSH-backed repos whose relay git
is unspanned). Caveats: the v155 main side already had static windows
(512 KB/stream, 2 MB aggregate), so the leak requires the premature-credit
path to keep refilling those windows; and it only covers remote/runtime
terminals, so it cannot be the whole story if OOM sessions were purely local.

**Falsify/confirm:** field — after §6 instrumentation, `terminalOutputQueue.*`
counts at highwater; local repro — remote (SSH) terminal + `yes`/build spew
for 30 min at v1.4.155 vs HEAD, watch precise heap.

### H4 — Large string working sets refreshed passively (combined diff / editor text)

At v1.4.155 `CombinedDiffViewer` retained full `originalContent`/
`modifiedContent` strings for every section with no byte budget (the unlanded
slice `1edaa5ebc8` adds a 24 MB cap + eviction — implying known unbounded
retention). A diff tab left open while agents rewrite files refreshes
passively via fs events. This explains hundreds of MB for giant dirty diffs,
and matches the codeg-dev overnight profile, but reaching 3.5 GB requires
either pathological diffs or snapshot retention across refreshes (not
proven).

**Falsify/confirm:** byte-weighted store/section profiling at highwater
(§4 item 3); repro with a large dirty worktree + agent writing in a loop.

### H5 — Main-push fan-out retained per-event in renderer handlers

`fs:changed` coalesced event arrays are uncapped even after the unlanded
slices, and `worktrees:headIdentitiesChanged` re-pushes per-repo payloads on
a 2 s poll (scales with repo count; the 107-repo C2 machine had the fastest
early climb ≥323 MB/min). Renderer handlers were audited as replace-not-append
(§2.0), so this is ranked below H1–H4; it would need an unaudited append path
to matter.

### Cleared (with residual hygiene notes)

- Renderer store slices, IPC listener lifecycle, pollers, metadata/slug/
  github caches, breadcrumb/OTel machinery, subscription teardown (§2.0).
- Explicit PTY chunk buffers: scheduler queue (per-terminal char+chunk caps,
  disposal verified at 6 call sites incl. the detach branch), pre-handler
  buffer (512 KB×64), hidden-restore pending (capped + overflow latch),
  deferred-reattach live data (char+chunk caps), shutdown suspension
  (512 KB/pty × 64), eager dispatcher buffer (512 KB), all scan tails
  trimmed. All bounded at v1.4.155.
- Terminal teardown: every unmount path reaches `terminal.dispose()`;
  Terminal-keyed registries (scheduler map, live-manager set, serializers)
  all release; pane-key re-keying orphans no Terminal-holding structure.
- Webviews (0–3 in OOM bundles), web-runtime client (desktop bundle never
  loads it), zustand middleware history (none).
- Residual small-fry (bytes, not GB — fix as hygiene): `terminalScrollIntentByKey`
  / `terminalScrollIntentBindingByKey` (`terminal-scroll-intent.ts:52-53`)
  never deleted; PR-link `seenUrls` Set never evicted
  (`terminal-github-pr-link-detector.ts:135`); `warnedLostHandlerPtyIds` Set
  uncapped; scheduler `compactConsumedChunks` retains ≤63 consumed chunk
  strings outside `queuedChars` accounting; remote ack closures pin ~2-3× a
  queued chunk's accounted size (`remote-runtime-terminal-multiplexer.ts:560-566`).

### 2.0 Layers cleared by code inventory at v1.4.155 (verified file:line, second session)

An independent sweep of the renderer store/IPC/poller layer found **no
unbounded accumulator** at v1.4.155:

- `useIpcEvents.ts`: single effect, empty dep array, full teardown; pending
  event buffers capped (100 agent-status / 300 mobile-state, TTL'd). Only
  unpruned structure holds numbers keyed by connection id (negligible).
- All 80 store slices: no module-level Map/Set with writes and no deletes
  (beyond two trivial ones); recently-closed-tabs, nav history, agent
  stateHistory (max 20), sleeping-agent capture (paneKey-keyed, equality
  guard) all bounded; worktrees slice reaps per-tab/per-pty maps on
  reconcile.
- Periodic pollers (60 s memory sample, 60 s sleeping-agent capture, 15 s
  delivery watchdog, spinner clock) allocate nothing retained per tick.
- `metadata-request-cache` (500/200 + TTL), `repo-slug-index` (evicts to live
  repo set), github work items (byte-bounded) were already capped at
  v1.4.155.
- No OTel in the renderer; breadcrumbs are fire-and-forget IPC (30-entry cap
  main-side); the terminal freeze/WebGL ring is capacity-bounded.
- All 20 `useAppStore.subscribe` sites tear down correctly, including the
  async SSH-connect wait in `pty-connection.ts`.
- Zustand store has **no middleware** (no devtools/undo history retention).

Conclusion: the leak is **not** in the store/subscription/poller layer.
Remaining territory: the PTY output/replay path, xterm write pipeline,
editor/diff text retention, and native-adjacent paths (media/image decode).

---

## 3. What v1.4.155 did NOT have (fix-ancestry check, verified in git)

- `renderer_memory_highwater` (#9984, eb2508e7f3): in `v1.4.156-rc.0`, **not**
  in v1.4.155 — its absence from all 57 bundles is expected.
- #10179 bounded accumulators (8f40ddf328): reverted (aab112933e); re-land
  slices at HEAD are **only partial**: foundation `BoundedMap` (#10299,
  879aad7dd6), shared image/media limits (#10295), A1-shared-readers (#10294).
  The renderer-heavy slices — B-renderer-web (8714ba0299), B-renderer-editor-
  terminal (1edaa5ebc8), B-renderer-components (0dc8f0486e), B-renderer-state
  (73bf213b2a), B-ipc-fs-worktree (5d0bce4783), B-ipc-pty-runtime-remote
  (c1b301a560) — exist on branches but are **not in HEAD**.
- Since the leak reproduces on v1.4.152 (which predates #10179 entirely),
  re-landing those slices is defence-in-depth, not the root-cause fix.

### 3.1 What the unlanded #10179 slices actually bound (full diff sweep, ~20k lines)

A complete read of the six unlanded slices shows **none of them bounds a
renderer-side accumulator fed by every `pty:data` event**:

- `c1b301a560` (B-ipc-pty-runtime-remote): the heavy PTY accumulators it caps
  — `pendingData` (bare `new Map` at v1.4.152/155, `src/main/ipc/pty.ts`),
  the delivery-credit ledger, `TerminalPreviewOutputStream` pending arrays —
  are all **main-process** heap. They fit the "daemon terminals streaming,
  user idle" profile exactly but cannot explain renderer `usedJSHeapSize`.
- `73bf213b2a` (B-renderer-state): bounds renderer caches that were already
  small or interactive-driven; passive ones (worktree refresh queue, agent
  status clear retention, generation maps) hold ids/numbers, not output text.
- `5d0bce4783` (B-ipc-fs-worktree): main-process scan budgets; the coalesced
  `fs:changed` event array pushed to the renderer remains uncapped even after
  the slice.
- `0dc8f0486e` (B-renderer-components): `automation-run-output-snapshot.ts:67`
  `chunks: string[]` compaction — the strongest genuinely renderer-side
  passive candidate in the set (grows per automation output chunk; a 256 KB
  char cap existed but the chunk array did not). Note: slice does not build
  standalone (imports `github-work-item-details-cache` from 73bf213b2a).
- `1edaa5ebc8` (B-renderer-editor-terminal): shutdown-window event caps and
  interactive diff-text caps; **not** the live PTY output path.
- `8714ba0299` (B-renderer-web): web-client bundle only — the desktop
  renderer never loads `src/renderer/src/web/*`; ruled out for C1.

All top candidates already existed unbounded at v1.4.152; the slices add
bounding machinery, not new accumulators — consistent with the leak
reproducing on 1.4.152 and with re-land being defence-in-depth only.

---

## 4. Smallest instrumentation that names the accumulator on the next field crash

Ordered by information-per-line-of-code:

1. **`app.commandLine.appendSwitch('enable-precise-memory-info')`** — one line
   next to the js-flags append in
   `src/main/startup/renderer-heap-headroom.ts`. Removes both the 6%
   bucketing and the 20-minute cache (50 ms freshness). The very next field
   bundle then shows the true climb shape (boot burst vs. drip vs. sawtooth),
   real climb rates, and correct highwater timing. No fingerprinting concern
   in a desktop app; negligible cost.
2. **Backport + strengthen `renderer_memory_highwater`** (exists at HEAD):
   thresholds `[0.4, 0.6, 0.75, 0.85]`, and register contributors beyond
   `store` (currently the only one at HEAD — verified,
   `src/renderer/src/store/index.ts:98`): pane-manager pane/terminal counts,
   terminal-output-scheduler queue stats (`debugState` already tracks
   queuedChars/peaks but is gated behind `e2eConfig.exposeStore` —
   `pane-terminal-output-scheduler.ts`), IPC listener counts, webview
   registry, React root count.
3. **Byte-weighted store profiling at the top threshold.** The existing
   `summarizeStateCollectionSizes` reports entry *counts*; a leak of a few
   entries holding giant strings is invisible. At ≥0.75, walk the top slices
   with a depth-bounded, budgeted string-length estimator.
4. **V8 heap statistics at threshold crossings**: `process.getHeapStatistics()`
   via preload (`number_of_native_contexts`, `number_of_detached_contexts`,
   external memory) — detached-context count would instantly confirm/kill any
   "detached document/webview/iframe" hypothesis.
5. **Safety valve** (report's fix #2): at ≥0.85 emit profile + graceful
   state-preserving reload. Converts hard kills into controlled reloads and
   caps user data loss while the accumulator is hunted.

---

## 5. Recommended next experiments

1. **Ship §6 and wait one field cycle.** codeg-dev alone produces a crash
   every ~90 min; with precise memory + 4-level highwater + the two new
   contributors, the very next bundle answers H1 (`paneTerminals.live` +
   `terminalElements` vs heap), H3 (`terminalOutputQueue.*`), and gives the
   true climb shape (boot burst vs drip vs sawtooth).
2. **Local repro for H1** (`ORCA_RENDERER_HEAP_MB` lowered to ~1024 to
   shorten time-to-OOM): SSH or remote-runtime workspace, activate 10+
   worktrees whose tabs stream (`yes` loop or an agent), switch away from
   each; watch precise heap and `paneTerminals.live`. Heap that never
   plateaus as activations accumulate = H1 confirmed. Then prototype the
   **memory-bounded retention fix** (evict un-parkable worktrees first with
   fallback teardown; hard cap on mounted worktrees before the parkability
   filter; byte-weighted hot-retain budget).
3. **Local repro for H2**: minimize the window, run ~10 agent panes emitting
   continuous OSC title changes for an hour; watch precise heap. Then add the
   `ptySideEffects.pending` gauge (spec in H2) and a queue cap with
   oldest-first collapse.
4. **Local repro for H3**: remote (SSH) terminal + sustained `yes` spew for
   30 min at v1.4.155 vs HEAD. If v155 climbs and HEAD doesn't, **backport
   #10012 to the 1.4.15x line**.
5. **Byte-weighted profiling (H4)**: at the 0.75 threshold walk top store
   slices + combined-diff sections with a budgeted string-length estimator
   (counts alone cannot see few-entries-of-giant-strings).
6. **Safety valve** (FINAL_REPORT fix #2): at ≥0.85 emit profile + graceful
   state-preserving reload — ship after #1 so each valve trigger also emits a
   named profile.
7. **Re-land the renderer #10179 slices** in dependency order (73bf213b2a
   before 0dc8f0486e — the latter imports the former's cache module) as
   defence-in-depth, explicitly not marketed as the C1 fix.
8. **Hygiene sweep** for the residual small-fry listed under "Cleared".

## 6. Implemented in this branch

- `src/main/startup/renderer-heap-headroom.ts` —
  `enablePreciseRendererMemoryInfo()` appends `enable-precise-memory-info`;
  called from `src/main/index.ts` startup next to the heap-headroom flag.
  Removes the ±3% bucketing and 20-minute cache from every
  `renderer_memory` / highwater sample.
- `src/renderer/src/lib/crash-diagnostics.ts` — highwater ladder
  `[0.6, 0.8]` → `[0.4, 0.6, 0.75, 0.85]` (deltas between profiles; a
  40 MB/min climb crosses 0.6→death too fast for a two-level ladder).
- `src/renderer/src/lib/pane-manager/pane-terminal-instance-census.ts` (new)
  — created/disposed/live pane-terminal counts as a `paneTerminals`
  contributor; wired in `pane-dom-creation.ts` (create) and
  `pane-lifecycle.ts` `disposePane` (dispose, membership-gated against
  double-count). `paneTerminals.live` and `terminalElements` climbing together
  with worktree activations is the direct H1 test; `live` >> `terminalElements`
  would instead indicate detached-terminal retention.
- `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts` —
  `terminalOutputQueue` contributor (queued terminals/chars/max-per-terminal)
  reusing the existing snapshot helper; production-visible unlike the
  e2e-gated debugState.
- `src/renderer/src/components/terminal-pane/pty-side-effect-pending-census.ts`
  (new) — `ptySideEffects.pending`/`processors` contributor; each
  `createPtyOutputProcessor` registers a gauge over its outstanding
  side-effect queue, disposed on transport `detach()`/`destroy()`. This is
  the H2 discriminator the other contributors cannot see.
- Tests: heap-headroom switch, 4-level highwater expectations, census unit
  tests (pane terminals + a live-processor enqueue/drain/dispose round-trip
  for the side-effect gauge). `pnpm run typecheck`, oxlint, `oxfmt --check`,
  and the pane-manager + terminal-pane transport + diagnostics suites pass.
