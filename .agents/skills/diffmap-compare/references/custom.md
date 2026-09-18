# Review authoring for both variants

## Reading experience

- Start with the user-visible problem and result. Use a table of PR, user action, and resulting behavior. Put revision hashes and implementation metadata at the end.
- Open on a useful, code-free overview. Keep the full explanation, examples, diagrams, verification, and file links in the main page. Never replace that page with a sentence-sized detail page.
- State review order explicitly by PR number. Do not say “bottom to top.” Omit non-goals unless they explain a practical limitation the reviewer needs to assess.
- Use familiar words: “remember which answer was opened,” not “browser read receipt”; “ask the desktop app to open the link,” not “cross the host boundary.” If a technical term matters, explain why it matters before naming it.
- Put a concise explanation immediately beside each graph. Graph labels describe actions and outcomes. Every linked call-stack row needs a complete purpose comment: what the code does and why. Expand implementation steps inline; comments wrap rather than truncate.
- Selecting a graph node, call-stack step, or file opens relevant code with its intent visible. Local file links select the source pane without navigating or reloading the page. Section links scroll within the overview.
- Version 1 retains a continuous document, table of contents, and single code pane. Version 2 keeps the overview visible on the left while file tabs, explanations, and code share the right pane. Reuse a file tab for another line in that file; do not create a new tab for each sentence.
- File summaries explain the file's role in plain language. Do not repeat the same paragraph under multiple headings. Keep compiler details secondary to the reason for looking at the code.
- Explain tests as actions and observed outcomes. Clearly identify scripted model responses, simulated browser launch, local server checks, and production checks not run. Keep both versions factually equivalent.

## Document syntax

Read the custom checkout's `README.md` and `src/explanations.ts` when authoring unfamiliar fields. Use the main markdown for the full explanation. In version 2, hidden file explanations supply context above code; avoid using explanation links as the primary navigation:

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
