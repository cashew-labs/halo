import type { Element, Root, RootContent } from "hast";
import type { Plugin } from "unified";

/**
 * HAST tag used so Streamdown's animate plugin will split inline code text.
 * Animate skips ancestors named `code` / `pre`; renaming inline `code` before
 * that pass keeps fenced blocks skipped while inline spans join the stagger.
 */
export const inlineCodeAnimateTag = "inline-code";

function isElement(node: RootContent | Root): node is Element {
  return node.type === "element";
}

function visit(node: Root | Element) {
  for (const child of node.children) {
    if (!isElement(child)) continue;

    if (child.tagName === "pre") {
      // Leave fenced `pre > code` alone so block highlighting stays unsplit.
      continue;
    }

    if (child.tagName === "code") {
      child.tagName = inlineCodeAnimateTag;
    }

    visit(child);
  }
}

/**
 * Retag inline `code` elements so Streamdown word animation includes them.
 * Must run after sanitize and before the animate rehype plugin.
 */
export const rehypeInlineCodeAnimate: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree);
  };
};
