import type { HaloMessage } from "@get-halo/client";
import {
  CodeBlock,
  colors,
  flex,
  monospace,
  radius,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";

// A shell command Halo ran into this session, such as a routine's script.
export function BashExecution({
  message,
}: {
  message: Extract<HaloMessage, { role: "bashExecution" }>;
}) {
  const rootClassName = useStyles(styles.root);
  const headerClassName = useStyles(styles.header);
  const commandClassName = useStyles(styles.command);
  const statusClassName = useStyles(styles.status);
  const noteClassName = useStyles(styles.note);
  const status = message.cancelled
    ? "Cancelled"
    : message.exitCode === undefined
      ? "Finished"
      : `Exit code ${message.exitCode}`;
  return (
    <article className={rootClassName} aria-label="Shell command">
      <div className={headerClassName}>
        <code className={commandClassName}>
          {"$ "}
          {message.command}
        </code>
        <span className={statusClassName}>{status}</span>
      </div>
      {message.truncated ? (
        <span className={noteClassName}>Showing the end of the output.</span>
      ) : undefined}
      {message.output.length > 0 ? (
        <CodeBlock lang="text">{message.output}</CodeBlock>
      ) : (
        <span className={noteClassName}>No output</span>
      )}
    </article>
  );
}

const styles = {
  root: style(
    flex({ direction: "column", gap: 2 }),
    radius.md,
    spacing.padding({ x: 3, y: 2 }),
    {
      minWidth: 0,
      backgroundColor: colors.gray[3],
      "& pre, & code": {
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
    },
  ),
  header: style(flex({ alignItems: "baseline", gap: 3 }), { minWidth: 0 }),
  command: style(
    monospace,
    text({ size: "md", fontWeight: 400, color: "highContrast" }),
    { flex: 1, minWidth: 0, fontFeatureSettings: '"calt" 1' },
  ),
  status: style(text({ size: "xs", color: "lowContrast" }), {
    whiteSpace: "nowrap",
  }),
  note: style(text({ size: "xs", color: "lowContrast" })),
};
