/* oxlint-disable react/iframe-missing-sandbox -- The inert extension preview keeps its origin for API and storage access, like ExtensionView. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AppAccessList } from "@get-halo/client";
import * as errore from "errore";
import {
  Avatar,
  Button,
  Checkbox,
  Flex,
  Thinking,
  Text,
  TextField,
  Menu,
  MenuItem,
  MenuTrigger,
  backgroundColor,
  borderColor,
  colors,
  flex,
  focusRing,
  radius,
  spacing,
  text,
} from "maui";
import {
  Apps,
  Check,
  DoubleChevronUpDown,
  Close,
  Globe,
  Link,
  Lock,
  Server,
  WarningTriangle,
} from "maui/icons";
import { style, useStyles } from "purse-styles";

type Access = "restricted" | "public";
export type SharePhase =
  | "idle"
  | "hosting"
  | "saving"
  | "host-error"
  | "save-error"
  | "loading"
  | "refreshing"
  | "load-error"
  | "removing";
export type ShareDraft = {
  access?: Access;
  savedAccess?: Access;
  people?: string[];
  savedPeople?: string[];
  email?: string;
  expanded?: boolean;
  copied?: boolean;
  invalid?: boolean;
  copyError?: boolean;
};

const options = [
  {
    id: "restricted" as const,
    title: "Restricted",
    description: "Only people you’ve added get access",
  },
  {
    id: "public" as const,
    title: "Public",
    description: "Anyone with the link has access",
  },
];
function initial(draft: ShareDraft) {
  const access: Access = draft.access ?? "restricted";
  return {
    access,
    savedAccess: draft.savedAccess ?? access,
    people: draft.people ?? [],
    savedPeople: draft.savedPeople ?? draft.people ?? [],
    pendingPeople: (draft.people ?? []).filter(
      (email) => !(draft.savedPeople ?? draft.people ?? []).includes(email),
    ),
    email: draft.email ?? "",
    expanded: draft.expanded ?? false,
    copied: draft.copied ?? false,
    invalid: draft.invalid ?? false,
    copyError: draft.copyError ?? false,
  };
}

class CopyError extends errore.createTaggedError({
  name: "CopyError",
  message: "Could not copy the link",
}) {}

function AccessLabel({ access }: { access: Access }) {
  const option = options.find((entry) => entry.id === access)!;
  return (
    <Flex column style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
      <Text size="sm" fontWeight={500}>
        {option.title}
      </Text>
      <Text size="xs" color="lowContrast" style={{ whiteSpace: "normal" }}>
        {option.description}
      </Text>
    </Flex>
  );
}

function PublicPreview({
  displayName,
  link,
  frameUrl,
  children,
}: {
  displayName: string;
  link: string | undefined;
  frameUrl?: string;
  children?: ReactNode;
}) {
  const preview = useStyles(styles.preview);
  const browser = useStyles(styles.browser);
  const chrome = useStyles(styles.chrome);
  const address = useStyles(styles.address);
  const dot = useStyles(styles.dot);
  const frame = useStyles(styles.frame);
  return (
    <div
      className={preview}
      role="img"
      aria-label={`${displayName} browser preview`}
    >
      <div className={browser} aria-hidden="true" inert>
        <div className={chrome}>
          <i className={dot} />
          <i className={dot} />
          <i className={dot} />
          <div className={address}>
            <Globe size="xs" />
            <Text size="xs" color="lowContrast">
              {link === undefined ? "Not hosted" : new URL(link).host}
            </Text>
          </div>
        </div>
        {children ??
          (frameUrl === undefined ? (
            <Flex column px={12} py={6} gap={4}>
              <Apps size="lg" />
              <Text size="xl" fontWeight={600}>
                {displayName}
              </Text>
              <Text size="sm" color="lowContrast">
                Your extension, on the web.
              </Text>
            </Flex>
          ) : (
            <iframe
              className={frame}
              title={`${displayName} preview`}
              src={frameUrl}
              tabIndex={-1}
              sandbox="allow-scripts allow-same-origin"
            />
          ))}
      </div>
    </div>
  );
}

/** The shared form used by the app dialog and the user-flow previews. */
export function ShareAppForm({
  draft,
  hosted,
  phase,
  hostingFailure,
  displayName,
  owner,
  link,
  frameUrl,
  preview,
  embedded = false,
  onClose,
  onSave,
  onRetry,
}: {
  draft: ShareDraft;
  hosted: boolean;
  phase: SharePhase;
  hostingFailure?: string;
  displayName: string;
  owner: { name: string; email: string };
  link: string | undefined;
  frameUrl?: string;
  preview?: ReactNode;
  embedded?: boolean;
  onClose(): void;
  onSave(access: AppAccessList): void;
  onRetry(): void;
}) {
  const [model, setModel] = useState(() => initial(draft));
  const bodyRef = useRef<HTMLDivElement>(null);
  const peopleList = useRef<HTMLUListElement>(null);
  const [morePeopleBelow, setMorePeopleBelow] = useState(false);
  const card = useStyles(styles.card, embedded && styles.embedded);
  const body = useStyles(styles.body);
  const heading = useStyles(styles.heading);
  const row = useStyles(styles.row);
  const picker = useStyles(styles.picker);
  const pickerField = useStyles(styles.pickerField);
  const people = useStyles(styles.people);
  const banner = useStyles(styles.banner);
  const error = useStyles(styles.error);
  const message = useStyles(styles.message);
  const recovery = useStyles(styles.recovery);
  const checkbox = useStyles(styles.checkbox);
  const remove = useStyles(styles.remove);
  const loading = useStyles(styles.loading);
  const footer = useStyles(styles.footer);
  const busy =
    phase === "hosting" ||
    phase === "saving" ||
    phase === "loading" ||
    phase === "refreshing";
  const unavailable =
    phase === "loading" || phase === "load-error" || phase === "removing";
  const locked = busy || unavailable;
  const visiblePeople = [...new Set([...model.people, ...model.pendingPeople])];
  useLayoutEffect(() => {
    // Keep recovery messages visible within the fixed-height dialog.
    const container = bodyRef.current;
    if (container?.querySelector('[role="alert"]'))
      container.scrollTop = container.scrollHeight;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reveal errors after their text or surrounding content changes.
  }, [phase, model.copyError, model.access, hostingFailure]);
  useLayoutEffect(() => {
    const list = peopleList.current;
    if (list === null) return;
    const measure = () =>
      setMorePeopleBelow(
        list.scrollHeight - list.clientHeight - list.scrollTop > 1,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reattach when the list remounts, and measure after its contents change.
  }, [model.access, unavailable, visiblePeople.length]);
  const added = model.people.filter(
    (email) => !model.savedPeople.includes(email),
  ).length;
  const removed = model.savedPeople.filter(
    (email) => !model.people.includes(email),
  ).length;
  const changed =
    model.access !== model.savedAccess || added > 0 || removed > 0;
  const done =
    !changed && (phase === "idle" || phase === "refreshing" || unavailable);
  const actionLabel =
    model.access !== model.savedAccess
      ? model.access === "public"
        ? "Make extension public"
        : "Restrict access"
      : added > 0 && removed > 0
        ? "Update access"
        : added > 0
          ? `Share with ${added}`
          : removed > 0
            ? `Unshare with ${removed}`
            : "Done";
  const willHost =
    !hosted && (model.access === "public" || model.people.length > 0);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(model.email.trim());
  const setAccess = (access: Access) =>
    setModel((previous) => ({ ...previous, access, expanded: false }));
  const save = () => {
    if (done) {
      onClose();
      return;
    }
    if (!hosted && !willHost) return;
    onSave({
      visibility: model.access === "public" ? "public" : "invited",
      members: model.people,
    });
  };
  const copy = async () => {
    if (link === undefined) {
      setModel((previous) => ({ ...previous, copyError: true }));
      return;
    }
    const result = await navigator.clipboard
      .writeText(link)
      .catch((cause) => new CopyError({ cause }));
    if (result instanceof Error) {
      console.warn("Could not copy extension link", result);
      setModel((previous) => ({ ...previous, copyError: true }));
      return;
    }
    setModel((previous) => ({ ...previous, copied: true, copyError: false }));
  };
  return (
    <section className={card} aria-label={`Share ${displayName}`}>
      <div ref={bodyRef} className={body}>
        <Flex row alignItems="center" justifyContent="between">
          <h2 className={heading}>Share “{displayName}”</h2>
          <Button
            variant="quiet"
            aria-label="Close sharing"
            isDisabled={busy && phase !== "refreshing"}
            onPress={onClose}
          >
            <Close size="sm" />
          </Button>
        </Flex>
        <div className={pickerField}>
          <Text size="xs" color="lowContrast">
            Access
          </Text>
          <MenuTrigger
            isOpen={model.expanded && !locked}
            onOpenChange={(expanded) =>
              setModel((previous) => ({ ...previous, expanded }))
            }
          >
            <Button
              className={picker}
              aria-label={`Access: ${model.access === "public" ? "Public" : "Restricted"}`}
              isDisabled={locked}
            >
              {model.access === "public" ? (
                <Globe size="md" />
              ) : (
                <Lock size="md" />
              )}
              <AccessLabel access={model.access} />
              <DoubleChevronUpDown size="sm" />
            </Button>
            <Menu
              onAction={(key) => {
                if (key === "public" || key === "restricted") setAccess(key);
              }}
              selectionMode="single"
              selectedKeys={[model.access]}
            >
              {options.map((option) => (
                <MenuItem
                  key={option.id}
                  id={option.id}
                  textValue={option.title}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    paddingRight: 28,
                  }}
                >
                  <Flex row gap={4} alignItems="start" style={{ flex: 1 }}>
                    {option.id === "public" ? (
                      <Globe size="sm" />
                    ) : (
                      <Lock size="sm" />
                    )}
                    <AccessLabel access={option.id} />
                  </Flex>
                </MenuItem>
              ))}
            </Menu>
          </MenuTrigger>
        </div>
        {(phase === "hosting" || willHost || hosted) && !unavailable && (
          <div className={banner} role="status">
            <Server size="sm" />
            <Flex column gap={4}>
              <Text size="sm">
                People with access can use this extension’s features, including
                any that change data or take actions through your connected
                tools.
              </Text>
              <Text size="sm">
                {hosted
                  ? "This extension is hosted on a separate server to help keep your workspace secure."
                  : "When shared externally, this extension is moved to a separate server to help keep your workspace secure."}
              </Text>
            </Flex>
          </div>
        )}
        {phase === "loading" && (
          <div className={loading} aria-busy="true">
            <Thinking
              variant="accent"
              size="1em"
              aria-label="Checking current access"
            />
          </div>
        )}
        {phase === "load-error" && (
          <div className={error} role="alert">
            <div className={message}>
              <WarningTriangle size="sm" />
              <Text size="sm">
                Couldn’t load access. Retry before making changes.
              </Text>
            </div>
            <div className={recovery}>
              <Button size="sm" variant="default" onPress={onRetry}>
                Retry
              </Button>
            </div>
          </div>
        )}
        {phase === "removing" && (
          <Text size="xs" role="status">
            This extension’s server is being removed. Access cannot be changed
            until removal finishes.
          </Text>
        )}
        {!unavailable && model.access === "public" && (
          <PublicPreview
            displayName={displayName}
            link={link}
            frameUrl={frameUrl}
          >
            {preview}
          </PublicPreview>
        )}
        {!unavailable && model.access === "restricted" && (
          <>
            <form
              className={row}
              onSubmit={(event) => {
                event.preventDefault();
                if (!validEmail) {
                  setModel((previous) => ({ ...previous, invalid: true }));
                  return;
                }
                setModel((previous) => ({
                  ...previous,
                  people: [
                    ...new Set([
                      ...previous.people,
                      previous.email.trim().toLowerCase(),
                    ]),
                  ],
                  pendingPeople: previous.savedPeople.includes(
                    previous.email.trim().toLowerCase(),
                  )
                    ? previous.pendingPeople
                    : [
                        ...new Set([
                          ...previous.pendingPeople,
                          previous.email.trim().toLowerCase(),
                        ]),
                      ],
                  email: "",
                  invalid: false,
                }));
              }}
            >
              <TextField
                aria-label="Add people by email"
                placeholder="Add people by email"
                value={model.email}
                isDisabled={busy}
                isInvalid={model.invalid}
                errorMessage={
                  model.invalid
                    ? "Enter a full email, like name@example.com."
                    : undefined
                }
                onChange={(email) =>
                  setModel((previous) => ({
                    ...previous,
                    email,
                    invalid: false,
                  }))
                }
              />
              <Button
                type="submit"
                variant="primary"
                isDisabled={busy || model.email.trim() === ""}
              >
                Add
              </Button>
            </form>
            <Flex column gap={4}>
              <Text size="xs" color="lowContrast">
                {model.pendingPeople.length > 0
                  ? "People · changes apply when you share"
                  : "People with access"}
              </Text>
              <ul
                ref={peopleList}
                className={people}
                data-more-below={morePeopleBelow}
                aria-label="People with access"
                tabIndex={visiblePeople.length > 4 ? 0 : undefined}
                onScroll={(event) => {
                  const list = event.currentTarget;
                  setMorePeopleBelow(
                    list.scrollHeight - list.clientHeight - list.scrollTop > 1,
                  );
                }}
              >
                <li>
                  <Avatar name={owner.name} size="lg" />
                  <Text
                    size="sm"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {owner.name}{" "}
                    <Text size="sm" color="lowContrast">
                      (you)
                    </Text>
                    <Text
                      size="xs"
                      color="lowContrast"
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {owner.email}
                    </Text>
                  </Text>
                  <Text size="xs" color="lowContrast">
                    Owner
                  </Text>
                </li>
                {visiblePeople.map((email) =>
                  model.pendingPeople.includes(email) ? (
                    <li key={email}>
                      <Avatar name={email} size="lg" />
                      <Text
                        size="sm"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {email}
                      </Text>
                      <fieldset
                        className={checkbox}
                        disabled={busy}
                        style={{
                          margin: 0,
                          padding: 0,
                          border: 0,
                          minWidth: 0,
                          flexShrink: 0,
                          opacity: busy ? 0.5 : 1,
                        }}
                      >
                        <Checkbox
                          label={`Share with ${email}`}
                          checked={model.people.includes(email)}
                          setChecked={(checked) => {
                            if (busy) return;
                            setModel((previous) => ({
                              ...previous,
                              people: checked
                                ? [...previous.people, email]
                                : previous.people.filter(
                                    (person) => person !== email,
                                  ),
                            }));
                          }}
                        />
                      </fieldset>
                    </li>
                  ) : (
                    <li key={email}>
                      <Avatar name={email} size="lg" />
                      <Text
                        size="sm"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {email}
                      </Text>
                      <Button
                        className={remove}
                        variant="quiet"
                        size="sm"
                        aria-label={`Remove ${email}`}
                        isDisabled={busy}
                        onPress={() =>
                          setModel((previous) => ({
                            ...previous,
                            people: previous.people.filter(
                              (person) => person !== email,
                            ),
                          }))
                        }
                      >
                        <Close size="xs" />
                      </Button>
                    </li>
                  ),
                )}
              </ul>
            </Flex>
          </>
        )}
        {phase === "host-error" && (
          <div className={error} role="alert">
            <div className={message}>
              <WarningTriangle size="sm" />
              <Text size="sm">
                Couldn’t finish hosting.{" "}
                {hostingFailure !== undefined && <>{hostingFailure} </>}
                {willHost
                  ? "Retry to finish moving this extension."
                  : "Add people or choose Public before retrying."}
              </Text>
            </div>
          </div>
        )}
        {phase === "save-error" && (
          <div className={error} role="alert">
            <div className={message}>
              <WarningTriangle size="sm" />
              <Text size="sm">
                Couldn’t save access. Your changes haven’t been applied. Retry
                to save them.
              </Text>
            </div>
          </div>
        )}
        {model.copyError && (
          <Flex column gap={3}>
            <Text size="xs" role="alert">
              {link === undefined
                ? "Private links aren’t available for local development workspaces. Open this extension in Halo instead."
                : "Couldn’t copy. Select the link and copy it manually."}
            </Text>
            {link !== undefined && (
              <TextField
                aria-label="Link to copy manually"
                value={link}
                isReadOnly
                onFocus={(event) => event.target.select()}
              />
            )}
          </Flex>
        )}
      </div>
      <div className={footer}>
        <Button onPress={() => void copy()}>
          {model.copied ? <Check size="sm" /> : <Link size="sm" />}
          {model.copied ? "Copied" : "Copy link"}
        </Button>
        <Button
          variant="primary"
          isDisabled={!done && (locked || (!hosted && !willHost))}
          onPress={save}
        >
          {phase === "hosting"
            ? "Hosting…"
            : phase === "saving"
              ? "Saving…"
              : phase === "host-error" || phase === "save-error"
                ? "Retry"
                : actionLabel}
        </Button>
      </div>
    </section>
  );
}

const styles = {
  card: style(radius.lg, {
    border: `1px solid ${borderColor.outline}`,
    backgroundColor: backgroundColor.element,
    overflow: "visible",
    display: "flex",
    flexDirection: "column",
    height: 580,
    maxHeight: "calc(100dvh - 48px)",
    boxSizing: "border-box",
  }),
  embedded: style({ border: 0 }),
  body: style(
    flex({ direction: "column", gap: 6 }),
    spacing.padding({ x: 8, y: 6 }),
    {
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      "& > *": { flexShrink: 0 },
    },
  ),
  heading: style(text({ size: "md", fontWeight: 500 }), { margin: 0 }),
  pickerField: style(flex({ direction: "column", gap: 2 }), {
    position: "relative",
  }),
  picker: style(spacing.padding({ x: 4, y: 3 }), {
    width: "100%",
    height: "auto",
    minHeight: 52,
    justifyContent: "start",
    "& > svg:first-child": { alignSelf: "start", marginTop: 1 },
    "& > svg:last-child": { marginLeft: "auto" },
  }),
  row: style(flex({ alignItems: "start", gap: 3 }), {
    "& > :first-child": { flex: 1, minWidth: 0 },
  }),
  people: style(focusRing(), flex({ direction: "column", gap: 2 }), {
    margin: 0,
    padding: 2,
    listStyle: "none",
    height: 200,
    flexShrink: 0,
    overflowY: "auto",
    "&[data-more-below='true']": {
      maskImage:
        "linear-gradient(to bottom, black calc(100% - 28px), transparent 100%)",
    },
    "& > li": {
      display: "flex",
      alignItems: "center",
      gap: spacing.value(4),
      height: 40,
      flexShrink: 0,
    },
    "& > li > svg": { flexShrink: 0 },
    "& > li:hover > button, & > li:focus-within > button": { opacity: 1 },
  }),
  checkbox: style({
    "& label > span:last-child": {
      position: "absolute",
      width: 1,
      height: 1,
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    },
  }),
  remove: style({
    "@media (hover: hover) and (pointer: fine)": { opacity: 0 },
  }),
  loading: style(flex({ alignItems: "center", justifyContent: "center" }), {
    flex: 1,
    minHeight: 0,
  }),
  preview: style({
    height: 230,
    overflow: "hidden",
    pointerEvents: "none",
    maskImage: "linear-gradient(to bottom, black 55%, transparent 100%)",
  }),
  browser: style(radius.lg, {
    minHeight: "100%",
    overflow: "hidden",
    border: `1px solid ${borderColor.outline}`,
    backgroundColor: backgroundColor.app,
  }),
  chrome: style(
    flex({ alignItems: "center", gap: 2 }),
    spacing.padding({ x: 4, y: 3 }),
    {
      backgroundColor: backgroundColor.elementHover,
      borderBottom: `1px solid ${borderColor.border}`,
    },
  ),
  address: style(
    radius.sm,
    flex({ alignItems: "center", gap: 3 }),
    spacing.padding({ x: 3, y: 2 }),
    {
      flex: 1,
      minWidth: 0,
      height: 22,
      marginLeft: spacing.value(4),
      backgroundColor: backgroundColor.app,
      border: `1px solid ${borderColor.border}`,
      "& > svg": { flexShrink: 0 },
      "& > span": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
    },
  ),
  dot: style(radius.circle, {
    width: 8,
    height: 8,
    backgroundColor: borderColor.outline,
  }),
  frame: style({
    width: "200%",
    height: 420,
    border: 0,
    transform: "scale(0.5)",
    transformOrigin: "top left",
  }),
  banner: style(
    radius.sm,
    flex({ alignItems: "start", gap: 3 }),
    spacing.padding({ all: 4 }),
    {
      backgroundColor: backgroundColor.elementHover,
      border: `1px solid ${borderColor.border}`,
      "& > svg": { flexShrink: 0 },
    },
  ),
  error: style(
    radius.sm,
    flex({ direction: "column", gap: 3 }),
    spacing.padding({ all: 4 }),
    {
      backgroundColor: colors.orange[2],
      color: colors.orange[11],
      border: `1px solid ${colors.orange[6]}`,
    },
  ),
  message: style(flex({ alignItems: "start", gap: 3 }), {
    "& > svg": { flexShrink: 0 },
  }),
  recovery: style(flex({ justifyContent: "end", gap: 3 })),
  footer: style(
    flex({ alignItems: "center", justifyContent: "between" }),
    spacing.padding({ x: 8, bottom: 6 }),
    { flexShrink: 0 },
  ),
};
