---
name: writing-error-messages
description: Writes and reviews clear, actionable user-facing error messages. Use when adding or improving error copy, validation messages, recovery instructions, or error states in UIs, CLIs, and APIs.
---

# Writing error messages

Tell the reader what went wrong and what they can do next. Apply this to the requested error states; do not turn a copy change into an error-handling redesign.

## Inspect the failure before writing

1. Identify the audience and the operation or input that failed.
2. Read the actual failure branches. Separate known facts from possible causes.
3. Check which recovery actions exist and what they do. Confirm automatic retries, downloads, support routes, and preserved data before mentioning them.
4. Write the problem and recovery instruction. Include the cause only when it is known and helps the reader recover.
5. Exercise the relevant failure states and check the rendered result or output.

## Write specific, useful copy

- Name the failed operation or the exact input constraint. Distinguish checking for updates, downloading, restarting to install, and opening the downloads page. Do not use one generic message for different failures.
- Do not guess the cause. A failed request does not prove an internet outage, an expired session, a permission problem, or a service outage.
- Give an available next step. Use the same words as the recovery control. “Try again” is useful when the failed operation is clear and retry is possible; it is not a complete error message by itself.
- If the reader cannot fix the problem, say what they can do: wait for a real automatic retry, use a supported alternative, or contact an existing support route. Do not invent a contact, a status page, a deadline, or a promise of recovery.
- Keep the message short, but retain the information needed to recover. Use a short problem heading when helpful, then put the known cause and recovery step in the body. Do not repeat the heading in the body.
- Use plain language, active voice, and a calm, neutral tone. Do not blame the reader.
- Avoid “Something went wrong,” “Oops,” “Uh-oh,” unnecessary apologies, and “please.” Replace vague words such as “invalid” with the actual requirement.
- Match the audience. Consumer UI copy usually needs the failed action and recovery step, not transport details or stack traces. Developer-facing errors may need an identifier, a path, the expected format, or a documented error code.
- Preserve useful diagnostics in the existing logs or details surface. Do not expose secrets, tokens, private data, or internal exception text just to make the message more specific.

## Keep presentation tied to recovery

- Place the error near the affected field or action. Keep related text and recovery controls together, using the existing design system's spacing and typography.
- For form validation, identify the field and its requirement; preserve entered values when the existing flow supports it.
- Keep button labels and instructions consistent. Do not recommend an action that is missing, disabled permanently, or unable to recover from this failure.
- Preserve accessible error associations and announcements. Newly displayed actionable errors must not be communicated only through color.
- Distinguish failure from progress. Say “retrying” or “downloading” only while that operation is actually running.

## Examples

These examples assume the operation and recovery action are available. Adapt them to the actual failure; do not copy an unsupported diagnosis.

| Known failure | Avoid | Prefer |
| --- | --- | --- |
| Google sign-in failed; another attempt is available | Authentication failed. | Couldn't sign in with Google. Try again. |
| Reading sign-in status failed; the app retries automatically | Can't sign in. | Couldn't check your sign-in status. Try again or wait for the app to retry. |
| Update check failed; cause is unknown | Check your internet connection. | Couldn't check for updates. Check again to retry. |
| Restarting to install failed | Something went wrong. | Couldn't restart the app to install the update. Try again. |
| Opening the downloads page failed | Update failed. | Couldn't open the downloads page. Try again. |
| A password is shorter than the required eight characters | Invalid password. | Use at least 8 characters for your password. |

Keep separate actions distinguishable in the UI. Pseudocode:

```tsx
if (installError) {
  return <p role="alert">Couldn't restart the app to install the update. Try again.</p>;
}
if (openDownloadsError) {
  return <p role="alert">Couldn't open the downloads page. Try again.</p>;
}
```

Use the application's existing components and error handling; the example illustrates message selection, not a new abstraction.

## Verify

- Trigger the actual failure through the consumer surface when practical. Control unavailable external systems at their boundary rather than making the UI invent a failure.
- Check that competing failure cases produce different, accurate messages and that each suggested action exists and remains usable.
- For UI changes, inspect wrapping, contrast, and placement in the relevant themes and narrow layouts. For CLI and API errors, check the actual output or response.
- Confirm that technical details remain available for diagnosis without replacing the user-facing message or disclosing sensitive data.
- State what was simulated or could not be verified. Keep changes within the requested scope.

## Sources

- [Elastic UI: How to write good error messages](https://eui.elastic.co/next/docs/patterns/error-messages/how-to-write-good-error-messages/)
- [Google: Writing Helpful Error Messages](https://developers.google.com/tech-writing/error-messages)
- [Google: Identify the error's cause](https://developers.google.com/tech-writing/error-messages/identify-the-cause)
