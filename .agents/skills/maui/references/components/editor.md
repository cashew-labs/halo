# Editor

Gallery: `/components/editor`. Import from `"maui"`. Composer chrome: [AI chat](../apps/ai-chat.md).

Unchromed TipTap markdown surface. Wrap it for padding, elevation, and actions.

```tsx
<Editor
  content={draft}
  onChange={setDraft}
  onSubmit={send}          // ⌘/Ctrl+Enter
  placeholder="Write…"
  size="sm"                // ProseSize: sm | md | lg
  editable={!streaming}
  aria-label="Compose message"
/>
```

- `content` is markdown; updates apply when the string changes.
- `onChange` receives markdown.
- CommonMark shortcuts (`#`, `**`, `-`, `>`).
- No chrome, no submit button — parent owns those.
