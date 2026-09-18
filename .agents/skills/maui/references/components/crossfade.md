# Crossfade

Gallery: `/components/crossfade`. Import from `"maui"`.

When `contentKey` changes, the previous view exits in `direction` while the next view enters from the opposite side. Views overlap (`AnimatePresence` `mode="sync"`). Offset is spacing step 6. The root clips overflow.

```tsx
<Crossfade direction="left" contentKey={slide.id}>
  <Text size="lg">{slide.title}</Text>
</Crossfade>
```

- `direction` is required: `"up" | "down" | "left" | "right"`. Gallery playground starts on `"left"`.
- `contentKey` is required. **Do not** put `key` on `Crossfade` itself or the exit is skipped.
- Timing is internal: enter is a spring (`visualDuration` 0.3, `bounce` 0.2); exit uses `motionDurationMs` (80ms) and ease-in-out. There are no public motion props.
- Reduced motion: opacity only.
