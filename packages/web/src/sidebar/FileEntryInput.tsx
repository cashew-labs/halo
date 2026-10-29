import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInteractOutside } from "react-aria";
import { TreeItem, TreeItemContent } from "react-aria-components/Tree";
import { TextField, colors, controlSize, spacing } from "maui";
import { ChevronDown, ChevronRight, File } from "maui/icons";
import { style, useStyles } from "purse-styles";

export type FileInputAction =
  | { kind: "file"; parent: string }
  | { kind: "directory"; parent: string }
  | { kind: "rename"; path: string; isDirectory: boolean };

type FileNameFieldProps = {
  action: FileInputAction;
  pending: boolean;
  error: string | undefined;
  onSubmit(path: string): void;
  onClose(): void;
};

export function FileEntryInput({
  items,
  ...props
}: FileNameFieldProps & { items?: ReactNode }) {
  const { action } = props;
  const isDirectory = isDirectoryAction(action);
  const row = useStyles(styles.row);
  // NavigationTreeItem enables arrow navigation from row children, which takes
  // arrow keys away from the field. A plain TreeItem in NavigationTree's
  // tab-navigation mode keeps keys in the field and focuses it as the row's child.
  return (
    <TreeItem
      id={
        action.kind === "rename"
          ? `file:${action.path}${isDirectory ? "/" : ""}`
          : "new-workspace-entry"
      }
      textValue={fieldLabel(action)}
      hasChildItems={action.kind === "rename" && isDirectory}
      focusMode="child"
      className={row}
    >
      <TreeItemContent>
        {({ isExpanded }) => (
          <FileNameField {...props} isExpanded={isExpanded} />
        )}
      </TreeItemContent>
      {items}
    </TreeItem>
  );
}

// Collections render FileEntryInput in a hidden pass, so the field's state
// lives here, inside the rendered row. Otherwise each keystroke reaches the
// controlled input a render late and the caret jumps to the end.
function FileNameField({
  action,
  pending,
  error,
  onSubmit,
  onClose,
  isExpanded,
}: FileNameFieldProps & { isExpanded: boolean }) {
  const parent =
    action.kind === "rename"
      ? action.path.slice(0, Math.max(0, action.path.lastIndexOf("/")))
      : action.parent;
  const originalName =
    action.kind === "rename"
      ? action.path.slice(action.path.lastIndexOf("/") + 1)
      : "";
  const isDirectory = isDirectoryAction(action);
  const [name, setName] = useState(originalName);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const icon = useStyles(styles.icon);
  const value = name.trim();
  const invalid =
    /[\\/]/.test(value) || value.startsWith(".") || value === "node_modules";
  const message =
    value === "node_modules"
      ? "This name is reserved."
      : invalid
        ? "Use a name without slashes or a leading dot."
        : error;
  // The tree prevents focus changes when its empty area is pressed, so the
  // field would otherwise stay focused instead of committing.
  useInteractOutside({
    ref: inputRef,
    onInteractOutside: () => inputRef.current?.blur(),
  });
  // Saving disables and blurs the field. When the server rejects the name,
  // return focus so the user can fix it or press Escape.
  useEffect(() => {
    if (pending) return;
    submitted.current = false;
    if (error !== undefined) inputRef.current?.focus();
  }, [pending, error]);
  return (
    <>
      <span className={icon} aria-hidden="true">
        {!isDirectory ? (
          <File size="sm" />
        ) : isExpanded || action.kind !== "rename" ? (
          <ChevronDown size="sm" />
        ) : (
          <ChevronRight size="sm" />
        )}
      </span>
      <TextField
        ref={inputRef}
        aria-label={fieldLabel(action)}
        size="sm"
        placeholder={
          action.kind === "rename"
            ? undefined
            : action.kind === "file"
              ? "Filename.ext"
              : "Folder name"
        }
        value={name}
        onChange={setName}
        autoFocus
        isDisabled={pending}
        isInvalid={message !== undefined}
        errorMessage={message}
        validationBehavior="aria"
        onFocus={() => {
          const input = inputRef.current;
          if (input === null || input.value !== originalName) return;
          const dot = isDirectory ? -1 : input.value.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            // Keep editing an invalid name; its error is already shown.
            if (!invalid) inputRef.current?.blur();
          }
        }}
        onBlur={() => {
          // Focus can change again before the mutation's pending state renders.
          if (pending || submitted.current) return;
          // Check the raw text too, so an untouched name with surrounding spaces
          // closes instead of being renamed to its trimmed form.
          // Leaving with an invalid name cancels, so the section never stays
          // locked behind an unfocused field.
          if (
            invalid ||
            value === "" ||
            name === originalName ||
            value === originalName
          ) {
            onClose();
            return;
          }
          const filename =
            action.kind === "file" && !/\.[^.]+$/.test(value)
              ? `${value.replace(/\.$/, "")}.md`
              : value;
          submitted.current = true;
          onSubmit(parent === "" ? filename : `${parent}/${filename}`);
        }}
      />
    </>
  );
}

function isDirectoryAction(action: FileInputAction) {
  return action.kind === "rename"
    ? action.isDirectory
    : action.kind === "directory";
}

function fieldLabel(action: FileInputAction) {
  if (action.kind === "rename")
    return `Rename ${action.path.slice(action.path.lastIndexOf("/") + 1)}`;
  return action.kind === "file" ? "New file name" : "New folder name";
}

const styles = {
  row: style(spacing.padding({ x: 4, y: 1 }), {
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr)",
    alignItems: "start",
    gap: spacing.value(2),
    paddingLeft: `calc(${spacing.value(4)} + (var(--tree-item-level, 1) - 1) * ${spacing.value(4)})`,
    minWidth: 0,
  }),
  // As tall as the small field, so the icon stays centered on the input when
  // an error message wraps below it.
  icon: style({
    display: "flex",
    alignItems: "center",
    height: controlSize.smHeight,
    color: colors.gray[11],
    "& > svg": { width: "16px", height: "16px" },
  }),
};
