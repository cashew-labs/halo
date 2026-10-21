import { useId, useState } from "react";
import {
  CodeBlock,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  colors,
  flex,
  monospace,
  radius,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { execJsSource, toolPartLabel, type ToolPart } from "./sessionView.ts";
import { parseToolArgumentRows } from "./toolArgumentRows.ts";
import { useWorkspaceQuery } from "../../api/ApiProvider.tsx";

export function ToolCall({ part }: { part: ToolPart }) {
  const workspace = useWorkspaceQuery().data;
  const workspaceRoot = workspace?.workspaceRoot;
  const label = toolPartLabel(part, workspaceRoot);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const rootClassName = useStyles(
    styles.root,
    expanded ? styles.rootExpanded : undefined,
  );
  const summaryClassName = useStyles(styles.summary);
  const shellClassName = useStyles(styles.shell);
  const bodyClassName = useStyles(styles.body);
  const nestedClassName = useStyles(styles.nested);
  const nestedCount = part.calls.length;
  const countLabel =
    nestedCount === 0
      ? undefined
      : ` · ${String(nestedCount)} tool ${nestedCount === 1 ? "call" : "calls"}`;

  const summary =
    label.kind === "shell" ? (
      <span className={shellClassName}>
        {"$ "}
        {label.text}
      </span>
    ) : (
      <>{label.text}</>
    );

  return (
    <div className={rootClassName}>
      <button
        type="button"
        className={summaryClassName}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${label.text}${countLabel ?? ""} (${part.tool.path})`}
        onClick={() => setExpanded(!expanded)}
      >
        {summary}
        {countLabel}
      </button>
      {expanded ? (
        <div
          id={detailsId}
          className={bodyClassName}
          role="region"
          aria-label={part.tool.path}
        >
          <ToolCallInput part={part} />
          {part.resultText !== undefined ? (
            <CodeBlock lang="text">{part.resultText}</CodeBlock>
          ) : undefined}
          {nestedCount === 0 ? undefined : (
            <div className={nestedClassName}>
              <Text size="sm" color="lowContrast">
                Tool calls
              </Text>
              <div role="list" aria-label="Nested tool calls">
                {part.calls.map((call) => (
                  <div role="listitem" key={call.id}>
                    <ToolCall part={call} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : undefined}
    </div>
  );
}

function ToolCallInput({ part }: { part: ToolPart }) {
  const js = execJsSource(part);
  if (js !== undefined) return <CodeBlock lang="javascript">{js}</CodeBlock>;
  const rows = parseToolArgumentRows({ value: part.args });
  if (rows === undefined) {
    return (
      <CodeBlock lang="json">
        {JSON.stringify(part.args, undefined, 2)}
      </CodeBlock>
    );
  }
  return <ArgumentTable rows={rows} />;
}

function ArgumentTable({
  rows,
}: {
  rows: ReadonlyArray<{ name: string; value: string }>;
}) {
  return (
    <Table aria-label="Tool arguments">
      <TableHeader>
        <TableHead isRowHeader>Argument</TableHead>
        <TableHead>Value</TableHead>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name} id={row.name}>
            <TableCell>{row.name}</TableCell>
            <TableCell>{row.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const labelStyle = style(
  text({ size: "md", fontWeight: 400, color: "lowContrast" }),
  {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
);

const styles = {
  root: style(flex({ direction: "column", gap: 2 }), radius.md, {
    minWidth: 0,
  }),
  rootExpanded: style(spacing.padding({ x: 3, y: 2 }), {
    backgroundColor: colors.gray[3],
  }),
  summary: style(labelStyle, {
    textAlign: "left",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    width: "100%",
  }),
  shell: style(monospace, { fontFeatureSettings: '"calt" 1' }),
  nested: style(flex({ direction: "column", gap: 2 }), { minWidth: 0 }),
  body: style(flex({ direction: "column", gap: 3 }), {
    minWidth: 0,
    "& pre, & code": {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  }),
};
