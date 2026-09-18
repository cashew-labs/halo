# Custom review authoring

This is the experimental counterpart to the untouched upstream skill. It captures the user's requested review experience, not rules to impose on upstream.

## Reading experience

- Start with a short overview and an ordered list of what to review. Give each step a concise explanation and a link to its details. Avoid repetitive goals/non-goals sections and repeated versions of the same flow.
- Use plain language to explain where code runs and what services/classes do. A class is not automatically a deployed service. Explain unfamiliar names before relying on them.
- The overview is the first, permanent tab on the **left**. Clicking a step, component or symbol opens an active detail tab in its place. Diagrams and examples stay inline with those details. No separate Diagram/Details pages, Back/Forward controls, Done button, or Components and next steps footer.
- The **right** shows the selected file's code. An About this file card names its exact path, purpose and changes. Populate a file explanation for every included patch so this card stays accurate when switching sources. Files can be chosen from the overview's file list; do not add a redundant dropdown.
- Detail pages should mix concise explanations with worked examples, realistic JSON/data, pseudocode or linked call stacks when they help. Use simple, selectable diagrams whose labels match the surrounding text. Avoid graphics with no explanation.
- Explain important classes, services and functions, including inputs and outputs. Code symbols open a left-side inspector with compiler-derived contracts; authored descriptions complement those types. Do not duplicate giant type declarations in the overview.
- Describe tests by actions and outcomes they actually checked. Distinguish simulated boundaries, live integrations and checks not run.

## Document syntax

Read the custom checkout's `README.md` and `src/explanations.ts` when authoring unfamiliar fields. The main markdown links to hidden explanations:

```md
1. [Where the request runs](explain:request-flow) — Follow the request into the server and storage.

[RequestService](explain:request-service) handles accepted requests.
```

An explanation uses a JSON fence. Real sources can be whole files, qualified symbols or line ranges. Related destinations should be links in the explanation's diagram or call stack, not a separate footer.

````md
```explain:request-service
{
  "title": "RequestService · validates and stores requests",
  "summary": "One instance in the server validates incoming requests before storing them.",
  "file": "src/RequestService.ts",
  "changes": "Checks the workspace owner before saving a request.",
  "sources": ["src/RequestService.ts#RequestService"],
  "symbols": ["src/RequestService.ts#RequestService"],
  "inputs": "The configured store and authenticated workspace identity.",
  "outputs": "A service instance; save() returns an ID or a storage error.",
  "steps": ["Check the authenticated workspace.", "Store the accepted request."],
  "callstack": "RequestService.save() [[src/RequestService.ts#RequestService.save]]\n└── Store.insert() [[src/Store.ts#Store.insert]]",
  "flowCaption": "Source-checked execution sketch; not a recorded runtime trace.",
  "codeExample": "{\"id\":\"request-123\",\"workspaceId\":\"workspace-A\"}",
  "codeLanguage": "json",
  "codeCaption": "Illustrative saved record, with unrelated fields omitted."
}
```
````

Use real paths, symbols and behavior from the reviewed repo, not the illustrative names above. `file` maps the explanation to the right pane's file summary; only one explanation per file should own this mapping. More specific method explanations can use `symbols` and `sources` without `file`.

`symbols` keys are `path#Class` or `path#Class.method`. Append `:method` or another compiler kind only when names are ambiguous (for example a static method and instance field sharing a name).

Optional `diagram` is a Mermaid string with `%% ref node:<id> [[explain:<id>]]` or source references. `diagramCaption`, `callstack`/`flowCaption` and `codeExample`/`codeLanguage`/`codeCaption` render inline in the detail page.

Append real Git patches in `source-diff:<id>:<path>` fences. Use the same base/head as upstream. Preserve patch content and line numbers. The overview need not reproduce all these source details: linked steps and the automatic file list are the entry points.
