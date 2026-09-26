# Routines

A routine runs an extension's work on a schedule. It belongs to one extension; an extension can own several routines, and an extension may consist only of routines. The workspace server schedules them while Halo runs. Each run opens a new session named after the routine and its time, such as `Book haircut · Sep 25, 8:00 AM`. The user reads the result there and can ask follow-up questions in that session.

Manage routines with the `halo routine` CLI. Add `--format json` when another command parses the output.

## Choose the action

- `--command` runs a shell command without a model call. Use it for deterministic work such as syncing data, calling an API, or running an extension script. It runs in `.halo/extensions/<id>/` by default, or in `--cwd <workspace-relative path>`, with the same shell environment as the agent's bash tool. The command can run for up to 10 minutes. Exit code 0 completes the run; any other exit code fails it. Its output is recorded in the session.
- `--prompt` asks the agent to do the work in the new session. Use it when the work needs judgment, workspace files, or connected tools. Write the prompt as a complete instruction; the run has no other context.

Put scripts in the extension directory, such as `scripts/sync.sh`, make them executable, and test them by hand before scheduling them.

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
halo routine list [--extension appointments]
halo routine run <routineId>        # start now in a new session
halo routine history <routineId>    # newest first: status, error, sessionId
halo routine update <routineId> --cron "0 9 * * 1"
halo routine pause <routineId>
halo routine resume <routineId>
halo routine remove <routineId>
```

`add` also accepts `--paused`. `update` changes only the options you pass; past runs keep their sessions.

## Behavior

- A run that starts while the routine's previous run is still running is recorded as `skipped`.
- Occurrences missed while Halo was stopped are skipped, not caught up. Runs in progress when Halo stops are recorded as `interrupted`.
- A paused routine does not run on schedule. `halo routine run` still starts it.
- If the extension directory is missing, each run is recorded as `skipped` until the extension returns.
- Removing a routine keeps the sessions from its past runs.
- The Extensions sidebar lists each routine under its extension. The routine page shows its schedule, next and last run, run history, and each run's session.

## Verify

After adding or changing a routine, run `halo routine run <id>`, then check `halo routine history <id>` until the run is `completed`. For a failed run, read its `error` and its session, fix the script or prompt, and run it again. Report the schedule back to the user in their time zone.
