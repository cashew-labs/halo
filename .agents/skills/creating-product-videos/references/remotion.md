# Remotion render recipe

## Isolated setup

From the repository root, create `tmp/<video-name>/` with a private ESM
`package.json`. Install matching versions of `remotion`, `@remotion/bundler`,
and `@remotion/renderer`, plus React/React DOM and the project's Maui package
alias. Remotion 4.0.539 is a known-working baseline,
not a requirement to downgrade an existing project. Match production React and
Maui for new captures. Use `npm --prefix tmp/<video-name> install --workspaces=false`.

Copy this skill's `scripts/render.mjs` into that directory. Create `Video.tsx`
with a registered Remotion root and `public/` for PNG captures and a locally
available, licensed Inter font. Do not reference another task's `tmp/` files.
The composition should use `staticFile()`/`Img` for captures. Drive animation
from `useCurrentFrame()`, never wall-clock timers or live network responses.

Register a `Composition` with an explicit ID, dimensions, FPS, and duration.
Choose dimensions for the destination: for example, 1280×720 for landscape,
1080×1920 for portrait, or 1080×1080 for square. Resize the layout rather than
stretching the screenshots.

Load Inter through a local `@font-face`. Use `useDelayRender()` with a handle
created once in state; wait for `document.fonts.load()` for the weights in use,
then call `continueRender(handle)` or `cancelRender(error)`. Put the composition
inside `MauiProvider` and set its theme deterministically. Ensure fonts are also
loaded in the fixture before capturing screenshots.

If a fixture imports Halo source, use a narrow Vite source allowlist and align
React/React Query versions so providers and hooks resolve to the same instances.
Read the flow-preview skill's fixture setup when adapting an existing preview.
Start any capture server through the repo's supervised service workflow.

## State transitions

Clamp interpolation outside its range. When replacing text-bearing captures,
fade through the underlying surface rather than drawing different labels over
one another:

```tsx
// progress is clamped to 0…1 across a short transition.
<Img src={previousImage} style={{ opacity: Math.max(0, 1 - progress * 2) }} />
<Img src={nextImage} style={{ opacity: Math.max(0, progress * 2 - 1) }} />
```

The images occupy the same absolute-positioned slot. If `previousImage` and
`nextImage` are identical, show one at full opacity instead of fading it again.

## Rendering

Run the copied renderer from the repository root, substituting your paths and
composition ID. It first renders stills under the entry point's `review/`
directory. Without `--video`, it stops there. `--frames` takes a comma-separated
list; choose frames covering each state and transition, not only the endpoints.

```sh
node tmp/product-video/render.mjs tmp/product-video/Video.tsx ProductVideo .amp/in/artifacts/product-video/demo.mp4 --frames 0,30,60
node tmp/product-video/render.mjs tmp/product-video/Video.tsx ProductVideo .amp/in/artifacts/product-video/demo.mp4 --video --frames 0,30,60
```

The renderer uses Remotion's browser discovery. To reuse an installed Chromium,
pass `--browser /absolute/path/to/chrome`; discover its actual path rather than
copying a version-specific orb path. It includes the Webpack
`resolve.fullySpecified: false` rule needed for Maui bundle resolution.
Output is H.264, CRF 18, concurrency 2.

Extract a whole-cut contact sheet, then inspect it and the MP4 with `view_media`:

```sh
mkdir -p tmp/product-video/contact
ffmpeg -hide_banner -loglevel error -y -i .amp/in/artifacts/product-video/demo.mp4 -vf 'fps=5,scale=640:-1' tmp/product-video/contact/frame-%03d.jpg
magick montage tmp/product-video/contact/frame-*.jpg -tile 4x -geometry +3+3 tmp/product-video/contact.jpg
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 .amp/in/artifacts/product-video/demo.mp4
```

Judge text at the MP4's delivery size, not only a downscaled contact sheet.
Keep the important action readable; remove or crop incidental details.
