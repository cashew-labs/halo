import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

function cssImportSource(source: string): boolean {
  return source.split("?")[0]?.endsWith(".css") === true;
}

function hasReasonComment(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (sourceCode.getCommentsBefore(node).some((comment) => comment.value.trim() !== "")) {
    return true;
  }
  const importLine = sourceCode.getLocFromIndex(node.start).line;
  return sourceCode.getCommentsAfter(node).some((comment) => {
    return (
      comment.value.trim() !== "" &&
      sourceCode.getLocFromIndex(comment.start).line === importLine
    );
  });
}

/** Ban CSS file imports in app code unless a comment explains why purse-styles cannot be used. */
export const noCssImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow CSS file imports; style app code with purse-styles, or leave a comment explaining why CSS is required.",
    },
    messages: {
      cssImport:
        "Don't import CSS files; use purse-styles. If a CSS file is required, add a comment explaining why.",
    },
  },
  createOnce(context) {
    const checkSource = (node: ESTree.Node, source: string) => {
      if (!cssImportSource(source) || hasReasonComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "cssImport" });
    };

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
      },
    };
  },
});
