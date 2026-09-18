---
name: logos
description: Source third-party product and integration logos from SVGL, vendor them into the website public folder, and reference the gethalo.dev URL. Use when adding or changing connection-card icons, brand marks, or other vendor logos. Do not use for Maui UI chrome icons or Halo's own artwork.
---

# Logos

Download third-party product logos from [SVGL](https://svgl.app/) and serve them from Halo's website.

1. Find the product on https://svgl.app/ or `GET https://api.svgl.app?search=<title>`. Prefer the icon `route`, not the wordmark. If `route` is `{ light, dark }`, use `light` unless the surface already swaps by theme.
2. Download that SVG into `apps/web-app/public/logos/`. Vite copies `public/` into the web-app dist root; the control plane serves it at `https://gethalo.dev`.
3. Point the display catalog at `https://gethalo.dev/logos/<file>.svg`. Do not hotlink svgl.app, gstatic product logos, or call the SVGL API from the renderer.
4. If SVGL has no product logo, reuse the vendor's parent mark already in `public/logos/` (Google products → `google.svg`). Do not invent filenames.

Google integration icons live on `googleIntegrationDisplay` in `@get-halo/client`. The connection card renders them with `LogoImage`. Maui icons stay the source for in-app chrome (`Search`, `Plus`, overflow, status).
