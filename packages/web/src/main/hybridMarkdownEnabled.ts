// The source-based editor stays opt-in while we exercise it alongside Tiptap.
export function hybridMarkdownEnabled() {
  return (
    new URLSearchParams(window.location.search).get("markdown") === "hybrid"
  );
}
