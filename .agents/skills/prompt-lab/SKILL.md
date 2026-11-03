---
name: prompt-lab
description: Revises an app's system prompt with a person reviewing real model replies one at a time on a local page. Use when asked to tune, tighten, or test a system prompt, an agent's tone or writing style, or to set up a prompt lab or prompt review loop.
---

# Prompt lab

The person judges real replies; you revise the prompt. Each round, you edit `candidate.md`, generate one reply per example message, and the reviewer marks each reply **Good** or **Needs work** on a review page and leaves written notes. Repeat until a round comes back good, then port the change to the app's source.

`scripts/prompt-lab.mjs` uses only Node built-ins (Node 20+). Run it from anywhere; paths are relative to the current directory. It calls any OpenAI-compatible `/chat/completions` endpoint. The page loads `marked`, `DOMPurify`, and `diff` from esm.sh.

## Set up

1. Save the app's current system prompt, as the model receives it, to a file. Read the app's source to find how it builds the prompt; render it with the app's own code rather than copying it by hand. For Halo, see [references/halo.md](references/halo.md).
2. Create the lab. Keep labs out of version control, such as under `tmp/`:

   ```sh
   node <skill>/scripts/prompt-lab.mjs init tmp/prompt-lab/<name> <prompt-file>
   ```

3. Edit `lab.json`: `baseUrl`, `model`, and `apiKeyEnv` (the variable that holds the key) should match production. `request` is merged into the request body, so put `max_tokens`, `temperature`, or provider flags there. `userNote` is placed before each user message to tell the model it has no tools; clear it if the app's prompt already says so.
4. Write 3–6 realistic user messages in `examples.json`, the kind real users send, typos and all. Pick ones that exercise what the reviewer wants changed. Avoid contrived tests that only check one rule.
5. Serve the page and give the reviewer its URL. In an Amp orb:

   ```sh
   amp orb service start prompt-lab --command 'node <skill>/scripts/prompt-lab.mjs serve tmp/prompt-lab/<name> --port 4310' --port 4310 --portal
   ```

   Elsewhere, run the `serve` command in a terminal and open `http://127.0.0.1:4310`.

## Each round

1. Edit `candidate.md`. Change the fewest words that address the notes.
2. Run `node <skill>/scripts/prompt-lab.mjs run tmp/prompt-lab/<name>` with the API key in the environment. It prints each reply's word count and input tokens. If input tokens are about the size of the user message alone, the model never received the system prompt.
3. Read the replies yourself in `rounds.jsonl` before asking for a review; regenerate if one plainly misses the notes.
4. The page picks up the new round on its own. Tell the reviewer it is ready.
5. Read their verdicts with `status`, and their written notes in the thread (in Amp, portal review comments arrive as messages). Record lasting preferences in the lab's `NOTES.md` so later rounds and agents keep them.

Rounds keep the full prompt and every reply, so earlier rounds stay comparable. The page diffs the latest round against `baseline.md`, so the reviewer sees every change since the lab began. When the reviewer changes their mind, the last verdict for a reply wins.

## Judgment

- Fix the cause, not the example. A rule written for one reply tends to break others; check that a change still reads well across all examples.
- Do not overfit. Prefer guidance that works most of the time over wording that forces one reply to pass.
- Swap in new examples after a few rounds so the prompt does not tune itself to the same three messages.
- When two wordings seem equal, show both in consecutive rounds and let the reviewer choose.

## Finish

When a round comes back good, apply the change to the app's prompt source, keeping its formatting and any interpolated values. Render the prompt again and compare it with `candidate.md`; the only differences should be ones you intend. Stop the service with `amp orb service stop prompt-lab` and delete the lab directory when the reviewer no longer needs it.
