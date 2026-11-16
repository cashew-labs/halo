---
name: product-doc
description: Explain systems, plan work, and review changes as visual documents. Run `product-doc --help` for usage details.
requires_bin: product-doc
command: product-doc
---

# product-doc

Explain systems, plan work, and review changes as visual documents

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
# Same as `product-doc serve .diffmap/specs/sessions/`
product-doc .diffmap/specs/sessions/
```

> `guide` prints how to write a spec. A spec is a directory of Markdown pages, such as `.diffmap/specs/<name>/`. `validate <spec>` checks it without starting a server. `serve <spec>` runs the local viewer. `share <spec>` publishes an unlisted gist. `update` (or `--update`) installs the latest product-doc.
