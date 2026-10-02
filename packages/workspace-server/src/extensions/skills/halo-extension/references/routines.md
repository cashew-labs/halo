# Routines

A routine runs work on a schedule. Personal routines need no extension; extension routines appear beneath their extension. In managed workspaces, the control plane keeps the schedule and wakes the VM when work is due. Local development schedules in the workspace server. Each run opens a new session named after the routine and its time, such as `Book haircut · Sep 25, 8:00 AM`. The user reads the result there and can ask follow-up questions in that session.

Manage routines with the `halo routine` CLI. Add `--format json` when another command parses the output.

## Choose the action

- `--command` runs a shell command without a model call. Use it for deterministic work such as syncing data, calling an API, or running an extension script. It runs in the workspace root for a personal routine and `.halo/extensions/<id>/` for an extension routine by default, or in `--cwd <workspace-relative path>`, with the same shell environment as the agent's bash tool. The command can run for up to 15 minutes. Exit code 0 completes the run; any other exit code fails it. Its output is recorded in the session.
- `--prompt` asks the agent to do the work in the new session. Use it when the work needs judgment, workspace files, or connected tools. Write the prompt as a complete instruction; the run has no other context.

Put scripts in the extension directory, such as `scripts/sync.sh`, make them executable, and test them by hand before scheduling them.
For a simple scheduled prompt, create a personal routine directly. Create an extension routine when the work belongs to an existing extension; do not scaffold an extension solely to hold a routine.

## Schedule

Use a five-field cron expression: minute, hour, day of month, month, day of week.

| Schedule                   | Cron           |
| -------------------------- | -------------- |
| Every weekday at 8:00 AM   | `0 8 * * 1-5`  |
| Every Monday at 9:30 AM    | `30 9 * * 1`   |
| Every 15 minutes           | `*/15 * * * *` |
| On the first of each month | `0 7 1 * *`    |

Always pass `--timezone` with the user's IANA time zone, such as `America/New_York`. Workspace machines often run in UTC, which is the default otherwise. Ask the user when their time zone is unknown.

## Commands

```sh
halo routine add appointments --name "Book haircut" --cron "0 8 * * 1" \
  --timezone America/New_York --command "./scripts/book.sh haircut"
halo routine add appointments --name "Weekly summary" --cron "0 17 * * 5" \
  --timezone America/New_York --prompt "Summarize this week's bookings in appointments.md"
halo routine add --name "Daily weather" --cron "0 8 * * *" \
  --timezone America/New_York --prompt "Check today's weather and give me a brief forecast."
halo routine update <routineId> --auto-archive-session
halo routine update <routineId> --show-session
halo routine list [--extension appointments]
halo routine run <routineId>        # start now in a new session
halo routine history <routineId>    # newest first: status, error, sessionId
halo routine update <routineId> --cron "0 9 * * 1"
halo routine pause <routineId>
halo routine resume <routineId>
halo routine remove <routineId>
```

`add` also accepts `--paused`. `update` changes only the options you pass; past runs keep their sessions.
`add` accepts `--auto-archive-session` too. By default, a run's session stays visible in Sessions. Auto archive marks it done after the run finishes, removing it from the Sessions sidebar while leaving it accessible from the routine's run list. `--show-session` restores that default for future runs.

## Behavior

- A run that starts while the routine's previous run is still running is recorded as `skipped`.
- Occurrences missed while Halo was stopped are skipped, not caught up. Runs in progress when Halo stops are recorded as `interrupted`.
- A paused routine does not run on schedule. `halo routine run` still starts it.
- If an extension routine's directory is missing, each run is recorded as `skipped` until the extension returns.
- Removing a routine keeps the sessions from its past runs.
- The Scheduled sidebar section lists personal routines. Extension routines appear under their extension. The routine page shows its schedule, editable action, and recent run sessions.

## Verify

After adding or changing a routine, run `halo routine run <id>`, then check `halo routine history <id>` until the run is `completed`. For a failed run, read its `error` and its session, fix the script or prompt, and run it again. Report the schedule back to the user in their time zone.
