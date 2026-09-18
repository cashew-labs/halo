const codeLanguages = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  json: "json",
  sh: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
} satisfies Record<string, string>;

function isCodeExtension(
  extension: string,
): extension is keyof typeof codeLanguages {
  return Object.hasOwn(codeLanguages, extension);
}

export function fileKind(path: string) {
  const extension = pathExtension(path);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension !== undefined && isCodeExtension(extension)) return "code";
  return "text";
}

function pathExtension(path: string) {
  const last = path.split("/").at(-1);
  if (last === undefined) return undefined;
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return last.slice(dot + 1).toLowerCase();
}
