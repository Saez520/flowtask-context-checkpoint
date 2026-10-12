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

The plugin uses only the `context` hook: agent-loop requests and tool continuations are covered; compaction, title generation, and transient generation are not. It resolves the requested session each time and requires a non-empty `parentID` and matching plugin location. The measured window uses the latest completed assistant response in the read-only OpenCode database: input + output + reasoning + cache read. Cache write and historical aggregates are excluded. The model's declared context limit is used when valid; otherwise the assumed limit applies. A reminder is added to that request only and is not saved.

Unavailable session data, malformed JSON, invalid token values, or database errors fail open: no reminder is added, the omission state is reset, and a safe diagnostic is logged. Completed assistant messages after a reminder are tracked by message ID; two consecutive untagged responses produce a warning. A response containing `[FLOWTASK_CHECKPOINT_CAPACITY: ...]` resets the omission count. Session deletion and plugin cleanup release state and event subscriptions.

## Submodule transports

The canonical maintenance remote is `git@github.com:Saez520/flowtask-context-checkpoint.git` and requires an authorized SSH key. Public read-only access is via HTTPS. Consumers without SSH credentials can initialize the FlowTask submodule with a local URL rewrite:

```sh
git -c url."https://github.com/Saez520/".insteadOf="git@github.com:Saez520/" submodule update --init --recursive
```

This changes only that Git invocation; the repository's `.gitmodules` remains configured for authenticated maintainers.

## Development

Requires Bun. Run `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`. Tests use deterministic isolated fixtures and must not open a user's OpenCode database.
