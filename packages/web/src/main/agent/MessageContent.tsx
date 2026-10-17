import {
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "streamdown";
import { Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { code } from "@streamdown/code";
import {
  Code,
  CodeBlock,
  backgroundColor,
  borderColor,
  motionEasing,
  motionStreamDurationMs,
  proseContainerStyle,
  proseHtml,
  proseStreamingMarkers,
  radius,
  shadow,
  spacing,
  type ProseSize,
} from "maui";
import { style, useStyles } from "purse-styles";
// Streamdown ships required markdown chrome as a CSS file.
import "streamdown/styles.css";

type MessageContentProps = {
  children: string;
  mode?: "static" | "streaming";
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
  table: MarkdownTable,
  inlineCode: InlineCode,
  code: MauiFencedCode,
};

function MarkdownTable({
  node: _node,
  className: _className,
  ...props
}: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  const className = useStyles(markdownTableClass);
  // Streamdown's default table caps height and relies on Tailwind for overflow.
  // Halo uses Maui, so keep the full table in flow and scroll wide tables here.
  return (
    <div className={className}>
      <table {...props} />
    </div>
  );
}

function InlineCode({
  node: _node,
  className: _className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  return <Code {...props}>{children}</Code>;
}

/** Markdown for user bubbles and streaming assistant replies, styled with Maui. */
export function MessageContent({
  children,
  mode = "static",
  isAnimating = false,
  size = "md",
  className,
}: MessageContentProps) {
  const rootClassName = useStyles(messageContentClass);
  const streamdownClassName = useStyles(
    proseHtml(size),
    streamdownRootClass,
    isAnimating ? proseStreamingMarkers : undefined,
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
        // `animated` must stay stably enabled; only `isAnimating` toggles.
        // Flipping `animated`/`mode` with the stream resets stagger state and
        // makes new blocks (blockquotes, lists) pop in out of order.
        animated={mode === "streaming" ? streamdownAnimate : false}
        isAnimating={isAnimating}
        mode={mode}
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

const messageContentClass = style(proseContainerStyle, {
  minWidth: 0,
});

const markdownTableClass = style({
  minWidth: 0,
  overflowX: "auto",
  "& table": {
    width: "100%",
    borderCollapse: "collapse",
  },
  "& th, & td": {
    padding: `${spacing.value(6)} ${spacing.value(8)}`,
    verticalAlign: "top",
    borderBottom: `1px solid ${borderColor.border}`,
    fontVariantNumeric: "tabular-nums",
  },
  "& th:not([align]), & td:not([align])": { textAlign: "start" },
  "& th": { fontWeight: 600 },
  "& th:first-child, & td:first-child": { paddingInlineStart: 0 },
  "& th:last-child, & td:last-child": { paddingInlineEnd: 0 },
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
