import { Markdown } from "@pierre/words/react";
import { createHighlightsPlugin } from "@pierre/words/highlights";
import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import {
  backgroundColor,
  borderColor,
  colors,
  monoFontStyle,
  motionStreamDurationMs,
  proseContainerStyle,
  proseHtml,
  shadowVars,
  spacing,
  useTheme,
  type ProseSize,
} from "maui";
import { style, useStyles } from "purse-styles";
// Words ships the streaming caret and fade-in keyframes as a CSS file.
import "@pierre/words/styles.css";

type MessageContentProps = {
  children: string;
  mode?: "static" | "streaming";
  /** When true, Words treats the markdown as actively streaming. */
  isAnimating?: boolean;
  size?: ProseSize;
  className?: string;
};

const highlightPlugins = {
  light: { code: createHighlightsPlugin({ theme: pierreLight }) },
  dark: { code: createHighlightsPlugin({ theme: pierreDark }) },
};

/** Markdown for user bubbles and streaming assistant replies, styled with Maui. */
export function MessageContent({
  children,
  mode = "static",
  isAnimating = false,
  size = "md",
  className,
}: MessageContentProps) {
  const { resolvedTheme } = useTheme();
  const rootClassName = useStyles(messageContentClass);
  const markdownClassName = useStyles(proseHtml(size), markdownRootClass);

  return (
    <div
      className={joinClassNames(rootClassName, className)}
      aria-live={isAnimating ? "polite" : undefined}
      aria-busy={isAnimating || undefined}
    >
      <Markdown
        className={markdownClassName}
        plugins={highlightPlugins[resolvedTheme]}
        // `animated` must stay stably enabled; only `isAnimating` toggles.
        animated={mode === "streaming" ? streamAnimate : false}
        isAnimating={isAnimating}
        mode={mode}
        controls={false}
        lineNumbers={false}
      >
        {children}
      </Markdown>
    </div>
  );
}

const streamAnimate = {
  animation: "fadeIn" as const,
  duration: motionStreamDurationMs,
};

const messageContentClass = style(proseContainerStyle, {
  minWidth: 0,
  // Break long URLs and other unbroken tokens instead of widening the pane.
  // `break-word` keeps min-content widths, so wide tables still scroll.
  overflowWrap: "break-word",
});

const root = "&[data-markdown='root']";

// Words tags each element with `data-markdown` and its stylesheet styles them
// with attribute selectors. Maui `proseHtml` owns the prose, so these rules
// outrank Words' margins, borders, and code frame; its caret and fade remain.
const markdownRootClass = style({
  [root]: {
    whiteSpace: "normal",
    lineHeight: "inherit",
    overflowWrap: "break-word",
  },
  [`${root} > :empty`]: { display: "none" },
  [`${root} :is(p, ul, ol, blockquote, table, h1, h2, h3, h4, h5, h6, [data-markdown='code-block'])`]:
    { margin: 0 },
  [`${root} [data-markdown='li'] > :is(ul, ol, p)`]: { margin: 0 },
  [`${root} [data-markdown='blockquote']`]: {
    opacity: 1,
    borderInlineStart: `2px solid ${colors.accent[10]}`,
    paddingInlineStart: "12px",
  },
  [`${root} :not(pre) > [data-markdown='code']`]: {
    ...monoFontStyle,
    borderRadius: "4px",
    paddingInline: spacing.value(2),
    paddingBlock: spacing.value(1),
    backgroundColor: colors.gray[3],
    color: colors.gray[12],
    boxDecorationBreak: "slice",
    fontSize: "0.875em",
    overflowWrap: "anywhere",
  },
  [`${root} [data-markdown='code-block']`]: {
    ...monoFontStyle,
    fontSize: "12px",
    color: colors.gray[12],
    boxShadow: shadowVars.subtle,
    backgroundColor: backgroundColor.app,
    border: "none",
    borderRadius: "6px",
  },
  [`${root} [data-markdown='code-header']`]: { display: "none" },
  [`${root} [data-markdown='code-block'] pre`]: {
    display: "block",
    font: "inherit",
    lineHeight: 1.6,
    maxHeight: "none",
    padding: "12px",
  },
  [`${root} [data-markdown='table']`]: {
    minWidth: 0,
    overflowX: "auto",
    fontSize: "inherit",
  },
  [`${root} :is(th, td)`]: {
    // Keep columns readable; the table scrolls instead of squeezing cells.
    minWidth: "10em",
    padding: `${spacing.value(6)} ${spacing.value(8)}`,
    verticalAlign: "top",
    border: "none",
    borderBottom: `1px solid ${borderColor.border}`,
    fontVariantNumeric: "tabular-nums",
  },
  [`${root} :is(th, td):not([align])`]: { textAlign: "start" },
  [`${root} :is(th, td):first-child`]: { paddingInlineStart: 0 },
  [`${root} :is(th, td):last-child`]: { paddingInlineEnd: 0 },
});

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}
