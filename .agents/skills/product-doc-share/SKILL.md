---
name: product-doc-share
description: Publish an unlisted gist and print https://diffmap.dev/g/<id>. Run `product-doc share --help` for usage details.
requires_bin: product-doc
command: product-doc share
---

# product-doc share

Publish an unlisted gist and print https://diffmap.dev/g/<id>

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | `string` | yes | The spec's directory, such as .diffmap/specs/<name>/ |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--public` | `boolean` |  | Create a public gist |

## Output

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gistId` | `string` | yes |  |
| `gistUrl` | `string` | yes |  |
| `viewerUrl` | `string` | yes |  |

## Examples

```sh
# Unlisted gist → https://diffmap.dev/g/<id>
product-doc share .diffmap/specs/sessions/
```
