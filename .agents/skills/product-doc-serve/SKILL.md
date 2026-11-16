---
name: product-doc-serve
description: Run the local viewer server. Run `product-doc serve --help` for usage details.
requires_bin: product-doc
command: product-doc serve
---

# product-doc serve

Run the local viewer server

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | `string` | yes | The spec's directory, such as .diffmap/specs/<name>/ |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port` | `number` |  | Port (default: a free port) |
| `--root` | `string` |  | Workspace root for file excerpts |

## Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | yes |  |
| `file` | `string` | yes |  |
| `warnings` | `array` | no |  |

## Examples

```sh
# Open the local viewer
product-doc serve .diffmap/specs/sessions/
```
