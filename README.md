# FlowTask Context Checkpoint

An OpenCode 2.0.27 plugin that adds a checkpoint reminder to eligible child-session model requests when measured context reaches a configurable threshold. It does not persist checkpoints, restart sessions, or alter conversation history; the runner remains responsible for acting on the reminder.

## Install

Configure the checkout as a plugin directory:

```jsonc
{
  "plugins": [{ "package": "./plugins/flowtask-context-checkpoint" }]
}
```

The default configuration is `enabled: true`, `checkpointThreshold: 0.70`, and `assumedContextLimit: 128000`. Thresholds must be in `(0, 1]`; the assumed limit must be a positive integer. Invalid values use defaults and produce a diagnostic without including user content.

## Behavior and limits

The plugin uses the `context` hook only for measurement and injection. A session is eligible only when a matching-location `session.created` event includes a non-empty `parentID`; a session missed during plugin reload is not inferred to be a child. The current measurement is taken from the latest completed step's `input + cache.read + cache.write` (each included once); output, reasoning, and historical aggregates are excluded. Each context evaluation reads the active model's context limit from `ctx.model.list()`; the assumed limit applies only when no valid capacity is available. A reminder is added to that request only and is not saved.

### Response-window tracking

An injected reminder arms one response window. The first `session.step.started` opens it, `session.text.ended` is the primary evidence source (assistant message ID, ordinal, and text), and the first `session.step.ended` whose `finish` is not `tool-calls` closes it. A `tool-calls` step leaves the same window open and cannot count an omission. `session.step.failed`, `session.execution.failed`, and `session.execution.interrupted` invalidate the active window and reset omission state. Text fragments are deduplicated by message ID and ordinal; completed message IDs are retained in a bounded FIFO of 32 entries.

Only a terminal response without the checkpoint marker is verified secondarily. The verifier reads `ctx.session.context` for the exact assistant message at most three times, after `0`, `150`, and `500` ms, with a `1000` ms timeout per read and the plugin-wide cancellation signal. A message containing `[FLOWTASK_CHECKPOINT_CAPACITY: ...]` resets the omission count; text without the marker confirms one omission. Missing messages, read errors, timeouts, and cancellation are `unknown`: they fail open, reset the omission state, and emit at most one safe `assistant-message-unavailable` diagnostic. They never count as omissions. Two consecutive confirmed untagged responses produce a warning.

Every session has a monotonic epoch. Compaction, failure, deletion, plugin cleanup, and a lost event stream advance it; a verifier result captured under an older epoch is discarded. This prevents a late history read from changing a newly reset session.

### Stream recovery and fail-open behavior

The event subscription is recovered after a cut with `250`, `500`, `1000`, `2000`, `4000`, then `5000` ms maximum backoff. Any received event resets the consecutive-failure counter. Before retrying, active windows are tainted, armed state and usage are invalidated, omission counts are reset, and the epoch advances; events lost during the cut are never replayed or inferred. After ten consecutive failed subscriptions the plugin emits one `event-stream-failed` diagnostic and stops retrying. Invalid or unavailable token usage also fails open: no reminder is injected, omission state is reset, and a safe diagnostic is logged.

Compaction invalidates the stored measurement; context remains unavailable until a later `session.step.ended` arrives, so pre-compaction usage is never reused. Session deletion and plugin cleanup release state and event subscriptions.

### OpenCode 2.0.27 smoke

A live isolated smoke against OpenCode `2.0.27` confirmed the observed ordering `context` before `session.step.started` for a child session, recorded once as `hook-order-observed:<sessionID>:context-before-step-started`. The trace contains no response text or token content. This is evidence for the installed version's observed path, not a guarantee for other OpenCode versions; the event-driven fail-open rules above remain authoritative.

## Submodule transports

The canonical maintenance remote is `git@github.com:Saez520/flowtask-context-checkpoint.git` and requires an authorized SSH key. Public read-only access is via HTTPS. Consumers without SSH credentials can initialize the FlowTask submodule with a local URL rewrite:

```sh
git -c url."https://github.com/Saez520/".insteadOf="git@github.com:Saez520/" submodule update --init --recursive
```

This changes only that Git invocation; the repository's `.gitmodules` remains configured for authenticated maintainers.

## Development

Requires Bun. Run `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`. Tests use deterministic isolated fixtures and must not open a user's OpenCode database.
