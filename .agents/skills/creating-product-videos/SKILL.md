---
name: creating-product-videos
description: Creates short Remotion product demos, before-and-after comparisons, and sizzle reels for social media using real UI captures, Maui styling, and Inter. Use when asked to make or edit a shareable product video.
---

# Creating product videos

Make the interaction understandable before making it cinematic. Use Remotion for
deterministic editing and Maui for presentation; use actual product UI for the
content. Read [the render recipe](references/remotion.md) when setting up a video.

## Capture the story

- Identify the user action and visible improvement. Read the component and its
  callers before choosing states. For comparisons, capture the actual earlier
  implementation from Git and the current implementation at the same width,
  theme, and fixture data. Respect the checkout's history/setup guidance.
- Prefer a local fixture rendering production components with inert callbacks
  and seeded data. Keep it outside production source. If old and new dependency
  versions differ, isolate them with package aliases and their own providers.
- Use the `halo-app` skill for the running Halo app or `using-agent-browser` for
  browser captures. Wait for fonts and images, use 2× device scale, and crop to
  the UI rather than including debug chrome. Use fictional account data.
- A fixture animation demonstrates design, not successful backend execution.
  Describe simulated steps honestly in the handoff. Do not fabricate third-party
  consent screens or expose real credentials/accounts for a social-ready clip.

## Edit for clarity

- Start with minimal copy: a title, or just **Before / After** for a comparison.
  Add at most a short bottom description if it clarifies the change. Keep step
  numbers, fixture notices, implementation details, and extra headers out of
  the video. Explain limitations in the reply instead.
- Default to Maui's light surfaces, spacing, radii, subtle shadows, and optional
  dotted backdrop. Use local Inter, including the captured UI, and await its
  load before rendering. Read the `maui` skill for current API/token names.
- Move a visible pointer to the real target, show a brief click cue, then change
  state. Let the resulting action/status read before the next cut. Keep pointer
  coordinates in the same transformed coordinate system as the UI.
- Use quick, spring-eased reframing to explain focus changes, not slow drifting
  zooms. Establish the canvas, focus a node, click it, pull back, then focus the
  selected preview when that is the story. Reset focus between destinations.
- Fade the entrance and state changes. Different text must fade out
  before replacement text fades in; source-over crossfades can ghost labels.
  Do not replay a transition when two phases use the same underlying UI state.
- Prefer a short cut: roughly 6–8 seconds for a focused interaction is a starting
  point, not a limit. Follow the requested length and aspect ratio; recompose
  for portrait rather than cropping landscape content until it is unreadable.

## Render and review

Work in `tmp/<video-name>/` with isolated dependencies. Do not add Remotion or
fixture-only dependencies to Halo packages. Keep composition source, fixtures,
local fonts, and input captures there. The bundled renderer is copied into that
workspace so it resolves those dependencies; see the reference for commands.

Render representative stills, including immediately before/after transitions,
then render H.264 MP4. Inspect the **actual video** with `view_media`, plus a
contact sheet covering the whole cut. Check sequence, pointer targets,
legibility at delivery size, clipping, and overlapping text.
Fix defects and inspect the replacement; successful encoding is not visual QA.

Keep scratch stills/contact sheets in `tmp/`. Put only final reviewable media in
`.amp/in/artifacts/<video-name>/` and embed the MP4 in the reply. Keep the handoff
short. Creating a social-ready video does not authorize publishing it or adding
music, logos, or personal data without the necessary permission/rights.
