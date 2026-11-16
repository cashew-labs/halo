---
name: product-doc-validate
description: Check a spec's syntax, diagrams, and annotations without starting a server. Run `product-doc validate --help` for usage details.
requires_bin: product-doc
command: product-doc validate
---

# product-doc validate

Check a spec's syntax, diagrams, and annotations without starting a server

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | `string` | yes | The spec's directory, such as .diffmap/specs/<name>/ |

## Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | yes |  |
| `valid` | `boolean` | yes |  |
| `pages` | `array` | yes |  |
