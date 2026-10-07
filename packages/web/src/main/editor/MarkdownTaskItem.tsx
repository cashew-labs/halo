import { TaskItem } from "@tiptap/extension-list";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Checkbox, flex } from "maui";
import { style, useStyles } from "purse-styles";

export const MarkdownTaskItem = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskCheckbox, {
      as: "li",
      attrs: ({ node }) => ({
        "data-type": "taskItem",
        "data-checked": String(node.attrs.checked === true),
      }),
    });
  },
});

function TaskCheckbox({ node, editor, updateAttributes }: NodeViewProps) {
  const className = useStyles(taskStyle);
  return (
    <NodeViewWrapper className={className}>
      <span
        className="halo-task-checkbox"
        contentEditable={false}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Checkbox
          label={`Task item checkbox for ${node.textContent || "empty task item"}`}
          checked={node.attrs.checked === true}
          setChecked={(checked) => {
            if (!editor.isEditable) return;
            updateAttributes({ checked });
            editor.commands.focus(undefined, { scrollIntoView: false });
          }}
        />
      </span>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

const taskStyle = style(flex({ alignItems: "baseline" }), {
  gap: "0.5em",
  "& > .halo-task-checkbox": { flexShrink: 0 },
  // The editable paragraph supplies the visible label; Maui labels the input.
  "& > .halo-task-checkbox label > span:not(.checkbox-toggle)": {
    display: "none",
  },
  "& > [data-node-view-content]": { minWidth: 0 },
});
