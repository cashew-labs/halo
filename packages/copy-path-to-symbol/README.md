# Copy Path to Selection

Run **Copy Path to Selection** from the Command Palette or editor context menu to copy a workspace-relative file path with the selected line numbers:

```text
packages/workspace-server/src/extensions/ExtensionHost.ts:12-18
```

A selection within one line copies `path:12`. With no text selected, the command copies the cursor’s line. Line numbers are one-based; a selection ending at the start of another line excludes that line. The command works in files without symbols.
