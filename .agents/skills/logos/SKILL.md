---
name: logos
description: Source third-party product and integration logos from SVGL. Use when adding or changing connection-card icons, brand marks, or other vendor logos. Do not use for Maui UI chrome icons or Halo's own artwork.
---

# Logos

Use [SVGL](https://svgl.app/) as the source for third-party product logos.

1. Find the product on https://svgl.app/ or `GET https://api.svgl.app?search=<title>`.
2. Copy the catalog `route` onto the display record. Hosted files are `https://svgl.app` plus that path, for example `https://svgl.app/library/gmail.svg`.
3. Prefer the icon `route`, not the wordmark. If `route` is `{ light, dark }`, use `light` unless the surface already swaps by theme.
4. Store the URL in the catalog. Do not call the SVGL API from the renderer, and do not add a gstatic `productlogos` URL or a downloaded copy when SVGL has the mark.
5. If SVGL has no product logo, use that vendor's parent brand mark from SVGL (Google products → `https://svgl.app/library/google.svg`). Do not invent filenames.

Google integration icons live on `googleIntegrationDisplay` in `@get-halo/client`. The connection card renders them with `LogoImage`. Maui icons stay the source for in-app chrome (`Search`, `Plus`, overflow, status).
