import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Tooltip,
  colors,
  flex,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useLocation } from "wouter";
import { FileEntryDialog, type FileEntryAction } from "./FileEntryDialog.js";
import { flushFileAutosaves } from "../main/useAutosaveFile.js";
import { File, Folder, FilePlus, FolderPlus, DotsHorizontal } from "maui/icons";
import {
  useApi,
  useWorkspacePathsQuery,
  useWorkspaceQuery,
  workspacePathsQueryKey,
} from "../api/ApiProvider.tsx";
import { reconnectStream } from "../api/reconnectStream.js";
import { useExpandSidebar } from "./navigation/NavigationSidebar.js";
import { SidebarItem } from "./navigation/SidebarItem.js";
import { SidebarSection } from "./navigation/SidebarSection.js";

import { FileEntryInput, type FileCreationAction } from "./FileEntryInput.js";

type FileAction = FileEntryAction | FileCreationAction;
type FileCreationRow = { parent: string; content: ReactNode };

type FileNavigationNode = {
  path: string;
  name: string;
  isDirectory: boolean;
  children: FileNavigationNode[];
};

type FileOperation =
  | { kind: "create"; path: string; entryKind: "file" | "directory" }
  | { kind: "delete"; path: string }
  | { kind: "move"; source: string; destination: string };

const fileDragType = "application/x-halo-workspace-path";

export function FilesystemSection() {
  const workspace = useWorkspaceQuery().data;
  const pathsQuery = useWorkspacePathsQuery(workspace);
  const queryClient = useQueryClient();
  const api = useApi();
  const expand = useExpandSidebar();
  const files = useMemo(
    () =>
      pathsQuery.data === undefined ? [] : buildFileNavigation(pathsQuery.data),
    [pathsQuery.data],
  );
  const workspaceRoot = workspace?.workspaceRoot;
  const [location, navigate] = useLocation();
  const [action, setAction] = useState<FileAction>();
  const [dragged, setDragged] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const dropRow = useStyles(styles.dropRow);
  const feedback = useStyles(styles.feedback);
  const controls = useStyles(styles.controls);
  const mutation = useMutation({
    mutationKey: ["workspace-entry"],
    mutationFn: async (operation: FileOperation) => {
      if (operation.kind === "create") {
        return await api.workspace.createEntry({
          path: operation.path,
          kind: operation.entryKind,
        });
      }
      const saved = await flushFileAutosaves();
      if (saved instanceof Error) throw saved;
      if (operation.kind === "delete")
        return await api.workspace.deleteEntry({ path: operation.path });
      return await api.workspace.moveEntry(operation);
    },
    onSuccess: async (_result, operation) => {
      const destination =
        operation.kind !== "move" ? operation.path : operation.destination;
      const segments = destination.split("/");
      expand(
        segments.map(
          (segment, index) =>
            `file:${[...segments.slice(0, index), segment].join("/")}/`,
        ),
      );
      await queryClient.invalidateQueries({
        queryKey: workspacePathsQueryKey(workspaceRoot),
      });
      await queryClient.invalidateQueries({
        queryKey: ["workspace-file"],
        refetchType: "none",
      });
      await queryClient.invalidateQueries({
        queryKey: ["workspace-preview"],
        refetchType: "none",
      });
      if (operation.kind === "create") {
        if (operation.entryKind === "file") navigate(fileRoute(operation.path));
        setAction(undefined);
        return;
      }
      if (!location.startsWith("/files/")) {
        setAction(undefined);
        return;
      }
      const openPath = decodeURIComponent(location.slice("/files/".length));
      if (operation.kind === "delete") {
        if (
          openPath === operation.path ||
          openPath.startsWith(`${operation.path}/`)
        )
          navigate("/", { replace: true });
        setAction(undefined);
        return;
      }
      if (
        openPath === operation.source ||
        openPath.startsWith(`${operation.source}/`)
      ) {
        navigate(
          fileRoute(
            operation.destination + openPath.slice(operation.source.length),
          ),
          { replace: true },
        );
      }
      setAction(undefined);
    },
  });
  const folders = ["", ...allFolders(files)];
  function openAction(next: FileAction) {
    mutation.reset();
    setAction(next);
    if (
      (next.kind === "file" || next.kind === "directory") &&
      next.parent !== ""
    )
      expand([`file:${next.parent}/`]);
  }
  function canDrop(folder: string) {
    if (dragged === undefined || mutation.isPending || action !== undefined)
      return false;
    const parent = dragged.slice(0, Math.max(0, dragged.lastIndexOf("/")));
    return (
      folder !== dragged &&
      !folder.startsWith(`${dragged}/`) &&
      folder !== parent
    );
  }
  function drag(path: string | undefined) {
    setDragged(path);
    setDropTarget(undefined);
  }
  function drop(event: DragEvent, folder: string) {
    if (
      !canDrop(folder) ||
      event.dataTransfer.getData(fileDragType) !== dragged
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const source = event.dataTransfer.getData(fileDragType);
    const name = source.slice(source.lastIndexOf("/") + 1);
    mutation.mutate({
      kind: "move",
      source,
      destination: folder === "" ? name : `${folder}/${name}`,
    });
    setDragged(undefined);
  }

  useEffect(() => {
    if (workspaceRoot === undefined) return;

    const controller = new AbortController();
    reconnectStream({
      name: "Workspace tree",
      signal: controller.signal,
      open: async () =>
        await api.workspace.events(undefined, { signal: controller.signal }),
      // Refresh after opening each stream to cover events missed while reconnecting.
      onOpen: async () =>
        await queryClient.invalidateQueries({
          queryKey: workspacePathsQueryKey(workspaceRoot),
        }),
      onItem: async () =>
        await queryClient.invalidateQueries({
          queryKey: workspacePathsQueryKey(workspaceRoot),
        }),
    });

    return () => controller.abort();
  }, [api, queryClient, workspaceRoot]);

  const creation: FileCreationRow | undefined =
    action !== undefined &&
    (action.kind === "file" || action.kind === "directory")
      ? {
          parent: action.parent,
          content: (
            <FileEntryInput
              key={`${action.kind}:${action.parent}`}
              action={action}
              pending={mutation.isPending}
              error={
                mutation.error === null ? undefined : mutation.error.message
              }
              onClose={() => setAction(undefined)}
              onSubmit={(path) =>
                mutation.mutate({
                  kind: "create",
                  path,
                  entryKind: action.kind,
                })
              }
            />
          ),
        }
      : undefined;

  return (
    <SidebarSection
      headerClassName={dropRow}
      renderHeader={(props) => (
        <div
          {...props}
          data-drop-target={
            canDrop("") && dropTarget === "" ? "true" : undefined
          }
          onDragOver={(event) => {
            if (canDrop("")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget("");
            }
          }}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              setDropTarget(undefined);
          }}
          onDrop={(event) => {
            setDropTarget(undefined);
            drop(event, "");
          }}
        />
      )}
      label={
        <span>
          Files
          {action === undefined && mutation.isError && (
            <span role="alert" className={feedback}>
              {mutation.error.message}
            </span>
          )}
        </span>
      }
      actions={
        <>
          <span className={controls}>
            <Tooltip content="New file">
              <Button
                variant="quiet"
                aria-label="New file"
                isDisabled={mutation.isPending || action !== undefined}
                onPress={() => openAction({ kind: "file", parent: "" })}
              >
                <FilePlus size="sm" />
              </Button>
            </Tooltip>
            <Tooltip content="New folder">
              <Button
                variant="quiet"
                aria-label="New folder"
                isDisabled={mutation.isPending || action !== undefined}
                onPress={() => openAction({ kind: "directory", parent: "" })}
              >
                <FolderPlus size="sm" />
              </Button>
            </Tooltip>
          </span>
          {action !== undefined &&
            action.kind !== "file" &&
            action.kind !== "directory" && (
              <FileEntryDialog
                action={action}
                folders={folders}
                pending={mutation.isPending}
                error={
                  mutation.error === null ? undefined : mutation.error.message
                }
                onClose={() => setAction(undefined)}
                onSubmit={(path) => {
                  if (action.kind === "delete")
                    mutation.mutate({ kind: "delete", path: action.path });
                  else
                    mutation.mutate({
                      kind: "move",
                      source: action.path,
                      destination: path,
                    });
                }}
              />
            )}
        </>
      }
    >
      {creation?.parent === "" && creation.content}
      {files.map((node) => (
        <FileNavigationItem
          key={node.path}
          node={node}
          onAction={openAction}
          onDrag={drag}
          dropTarget={dropTarget}
          onDropTarget={setDropTarget}
          canDrop={canDrop}
          onDrop={drop}
          pending={mutation.isPending || action !== undefined}
          creation={creation}
        />
      ))}
    </SidebarSection>
  );
}

function FileNavigationItem({
  node,
  onAction,
  onDrag,
  dropTarget,
  onDropTarget,
  canDrop,
  onDrop,
  pending,
  creation,
}: {
  node: FileNavigationNode;
  onAction(action: FileAction): void;
  onDrag(path: string | undefined): void;
  dropTarget: string | undefined;
  onDropTarget(path: string | undefined): void;
  canDrop(folder: string): boolean;
  onDrop(event: DragEvent, folder: string): void;
  pending: boolean;
  creation: FileCreationRow | undefined;
}) {
  const path = node.isDirectory ? node.path.slice(0, -1) : node.path;
  const label = useStyles(styles.fileLabel);
  const row = useStyles(styles.dropRow);
  const droppable = node.isDirectory && canDrop(path);
  return (
    <SidebarItem
      id={`file:${node.path}`}
      href={node.isDirectory ? undefined : fileRoute(node.path)}
      pageTitle={node.name}
      hasChildItems={node.isDirectory}
      icon={node.isDirectory ? Folder : File}
      className={row}
      render={(props) => (
        <div
          {...props}
          data-drop-target={
            droppable && dropTarget === path ? "true" : undefined
          }
          onDragOver={(event) => {
            if (droppable) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              onDropTarget(path);
            }
          }}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              onDropTarget(undefined);
          }}
          onDrop={(event) => {
            onDropTarget(undefined);
            if (node.isDirectory) onDrop(event, path);
          }}
        />
      )}
      trailing={
        <FileMenu
          label={`Actions for ${node.name}`}
          node={{ path, isDirectory: node.isDirectory }}
          onAction={onAction}
          disabled={pending}
        />
      }
      items={
        <>
          {node.isDirectory && creation?.parent === path && creation.content}
          {node.children.map((child) => (
            <FileNavigationItem
              key={child.path}
              node={child}
              onAction={onAction}
              onDrag={onDrag}
              dropTarget={dropTarget}
              onDropTarget={onDropTarget}
              canDrop={canDrop}
              onDrop={onDrop}
              pending={pending}
              creation={creation}
            />
          ))}
        </>
      }
    >
      <span
        className={label}
        draggable={!pending}
        data-file-path={path}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.setData(fileDragType, path);
          event.dataTransfer.effectAllowed = "move";
          onDrag(path);
        }}
        onDragEnd={() => onDrag(undefined)}
      >
        {node.name}
      </span>
    </SidebarItem>
  );
}

function FileMenu({
  label,
  node,
  onAction,
  disabled,
}: {
  label: string;
  node: { path: string; isDirectory: boolean };
  onAction(action: FileAction): void;
  disabled?: boolean;
}) {
  const button = useStyles(styles.menuButton);
  const parent = node.path;
  return (
    <MenuTrigger>
      <Button
        variant="quiet"
        aria-label={label}
        className={button}
        isDisabled={disabled}
      >
        <DotsHorizontal size="sm" />
      </Button>
      <Menu aria-label={label}>
        {node.isDirectory && (
          <MenuItem onAction={() => onAction({ kind: "file", parent })}>
            New file…
          </MenuItem>
        )}
        {node.isDirectory && (
          <MenuItem onAction={() => onAction({ kind: "directory", parent })}>
            New folder…
          </MenuItem>
        )}
        <MenuItem onAction={() => onAction({ kind: "rename", ...node })}>
          Rename…
        </MenuItem>
        <MenuItem onAction={() => onAction({ kind: "move", ...node })}>
          Move to…
        </MenuItem>
        <MenuItem onAction={() => onAction({ kind: "delete", ...node })}>
          Delete…
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

function allFolders(nodes: FileNavigationNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isDirectory
      ? [node.path.slice(0, -1), ...allFolders(node.children)]
      : [],
  );
}

function buildFileNavigation(paths: readonly string[]) {
  const roots: FileNavigationNode[] = [];
  const nodes = new Map<string, FileNavigationNode>();

  for (const listedPath of paths) {
    const terminalIsDirectory = listedPath.endsWith("/");
    const normalizedPath = terminalIsDirectory
      ? listedPath.slice(0, -1)
      : listedPath;
    const segments = normalizedPath.split("/");
    let siblings = roots;

    for (const [index, name] of segments.entries()) {
      const isDirectory = index < segments.length - 1 || terminalIsDirectory;
      const path = `${segments.slice(0, index + 1).join("/")}${
        isDirectory ? "/" : ""
      }`;
      const existing = nodes.get(path);
      const node =
        existing === undefined
          ? { path, name, isDirectory, children: [] }
          : existing;
      if (existing === undefined) {
        nodes.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }

  sortFileNavigation(roots);
  return roots;
}

function sortFileNavigation(nodes: FileNavigationNode[]) {
  nodes.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) sortFileNavigation(node.children);
}

function fileRoute(path: string) {
  return `/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

const styles = {
  controls: style(flex({ alignItems: "center", gap: 1 })),
  // Pull the 28px button into the row's block padding so file rows stay compact.
  menuButton: style({ marginBlock: "-2px" }),
  fileLabel: style({
    display: "block",
    width: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    userSelect: "none",
  }),
  dropRow: style({
    userSelect: "none",
    "&[data-drop-target='true']": {
      backgroundColor: colors.accent[4],
      boxShadow: `inset 0 0 0 1px ${colors.accent[8]}`,
    },
  }),
  feedback: style(text({ size: "xs", color: "lowContrast" }), {
    display: "block",
    whiteSpace: "normal",
    paddingBlock: spacing.value(2),
  }),
};
