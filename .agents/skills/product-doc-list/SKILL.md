---
name: product-doc-list
description: List running productdoc viewers. Run `product-doc list --help` for usage details.
requires_bin: product-doc
command: product-doc list
---

# product-doc list

List running productdoc viewers

## Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instances` | `array` | yes |  |
| `instances[].pid` | `number` | yes |  |
| `instances[].title` | `string` | yes |  |
| `instances[].url` | `string` | yes |  |
| `instances[].file` | `string` | yes |  |
