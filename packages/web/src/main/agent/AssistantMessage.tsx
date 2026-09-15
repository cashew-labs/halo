import {
  isValidElement,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "streamdown";
import {
  Streamdown,
  defaultRehypePlugins,
  useIsCodeFenceIncomplete,
} from "streamdown";
import { code } from "@streamdown/code";
import {
  Code,
  CodeBlock,
  backgroundColor,
  motionEasing,
  motionStreamDurationMs,
  proseHtml,
  proseMaxWidth,
  proseStreamingMarkers,
  radius,
  shadow,
  type ProseSize,
} from "maui";
import { style, useStyles } from "purse-styles";
import {
  inlineCodeAnimateTag,
  rehypeInlineCodeAnimate,
} from "./rehypeInlineCodeAnimate.ts";
import "streamdown/styles.css";

type AssistantMessageProps = {
  children: string;
  /** When true, Streamdown treats the markdown as actively streaming. */
  isAnimating?: boolean;
  size?: ProseSize;
  className?: string;
};

const supportedCodeLangs = new Set([
  "typescript",
  "javascript",
  "tsx",
  "css",
  "json",
  "bash",
  "ts",
  "js",
  "sh",
  "shell",
]);

function isSupportedCodeLang(lang: string): boolean {
  return supportedCodeLangs.has(lang.toLowerCase());
}

function extractText(node: ReactNode): string {
  if (node === undefined || node === null || node === true || node === false)
    return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return String(node);
}

function MauiFencedCode({
  className,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const pendingClassName = useStyles(pendingCodeShellClass);
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
  const text = extractText(children).replace(/\n$/, "");

  // While the fence is still open, keep plain text so Streamdown can keep
  // updating without remounting a highlighter on every chunk.
  if (isIncomplete || !isSupportedCodeLang(language)) {
    return (
      <pre className={pendingClassName}>
        <code className={className} {...props}>
          {text}
        </code>
      </pre>
    );
  }

  return <CodeBlock lang={language}>{text}</CodeBlock>;
}

/**
 * Plain element overrides so Streamdown's Tailwind utility classes are not
 * required — Maui `proseHtml` styles the tree instead. Drop incoming
 * `className` (Streamdown's `list-inside` / spacing utilities) so markers and
 * gaps stay under Maui control. Keep `children` intact for animate spans.
 */
const streamdownComponents: Components = {
  h1: ({ node: _node, className: _className, ...props }) => <h1 {...props} />,
  h2: ({ node: _node, className: _className, ...props }) => <h2 {...props} />,
  h3: ({ node: _node, className: _className, ...props }) => <h3 {...props} />,
  h4: ({ node: _node, className: _className, ...props }) => <h4 {...props} />,
  p: ({ node: _node, className: _className, ...props }) => <p {...props} />,
  ul: ({ node: _node, className: _className, ...props }) => <ul {...props} />,
  ol: ({ node: _node, className: _className, ...props }) => <ol {...props} />,
  li: ({ node: _node, className: _className, ...props }) => <li {...props} />,
  a: ({ node: _node, className: _className, ...props }) => <a {...props} />,
  blockquote: ({ node: _node, className: _className, ...props }) => (
    <blockquote {...props} />
  ),
  strong: ({ node: _node, className: _className, ...props }) => (
    <strong {...props} />
  ),
  em: ({ node: _node, className: _className, ...props }) => <em {...props} />,
  hr: ({ node: _node, className: _className, ...props }) => <hr {...props} />,
  inlineCode: InlineCode,
  // Retagged inline code while streaming (see rehypeInlineCodeAnimate).
  [inlineCodeAnimateTag]: InlineCode,
  code: MauiFencedCode,
};

function InlineCode({
  node: _node,
  className: _className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  return <Code {...props}>{children}</Code>;
}

/** Defaults + inline-code retag so animate can stagger inline code with prose. */
const streamingRehypePlugins = [
  ...Object.values(defaultRehypePlugins),
  rehypeInlineCodeAnimate,
];

/**
 * Streaming-friendly assistant message. Renders markdown with Streamdown and
 * Maui prose type styles (same reading scale as `Prose`).
 */
export function AssistantMessage({
  children,
  isAnimating = false,
  size = "md",
  className,
}: AssistantMessageProps) {
  const rootClassName = useStyles(assistantMessageClass);
  const streamdownClassName = useStyles(
    proseHtml(size),
    streamdownRootClass,
    isAnimating ? proseStreamingMarkers : undefined,
  );
  const rehypePlugins = useMemo(
    () => (isAnimating ? streamingRehypePlugins : undefined),
    [isAnimating],
  );

  return (
    <div
      className={joinClassNames(rootClassName, className)}
      aria-live={isAnimating ? "polite" : undefined}
      aria-busy={isAnimating || undefined}
    >
      <Streamdown
        className={streamdownClassName}
        components={streamdownComponents}
        plugins={{ code }}
        rehypePlugins={rehypePlugins}
        // `animated` must stay stably enabled; only `isAnimating` toggles.
        // Flipping `animated`/`mode` with the stream resets stagger state and
        // makes new blocks (blockquotes, lists) pop in out of order.
        animated={streamdownAnimate}
        isAnimating={isAnimating}
        mode="streaming"
        controls={false}
        lineNumbers={false}
      >
        {children}
      </Streamdown>
    </div>
  );
}

/** Snappy word fade-in for streaming tokens. */
const streamdownAnimate = {
  animation: "fadeIn" as const,
  duration: motionStreamDurationMs,
  easing: motionEasing,
  sep: "word" as const,
  stagger: 16,
};

const assistantMessageClass = style({
  maxWidth: proseMaxWidth,
  minWidth: 0,
});

// Drop Streamdown's Tailwind `space-y-*` dependency; Maui `proseHtml` owns gaps.
const streamdownRootClass = style({
  display: "flex",
  flexDirection: "column",
  whiteSpace: "normal",
  // Whitespace-only Streamdown blocks can show up as empty nodes; don't let
  // them create extra flex gaps.
  "& > :empty": {
    display: "none",
  },
});

const pendingCodeShellClass = style(radius.md, shadow.subtle, {
  backgroundColor: backgroundColor.app,
  margin: 0,
  overflowX: "auto",
  padding: "12px",
});

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}
