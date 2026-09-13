import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Flex,
  H1,
  MauiProvider,
  Padding,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  TextField,
} from "maui";
import {
  useQuery,
  type ExtensionViewProps,
} from "@get-halo/extension-sdk/view";
import * as errore from "errore";
import type router from "./api.js";
import type schema from "./schema.js";

class TasksError extends errore.createTaggedError({
  name: "TasksError",
  message: "Task operation failed",
}) {}

const tasksQuery = { collection: "tasks" } as const;

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export default function Tasks({
  api,
  storage,
}: ExtensionViewProps<typeof router, typeof schema>) {
  const [title, setTitle] = useState("Tasks");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const tasks = useQuery(storage, tasksQuery);
  useEffect(() => {
    void api
      .title()
      .then(setTitle)
      .catch((cause) => setError(new TasksError({ cause }).message));
  }, [api]);
  async function save(task: { id: string; label: string; done: boolean }) {
    const tx = storage.transact();
    tx.set("tasks", task);
    const saved = await storage
      .commit(tx)
      .catch((cause) => new TasksError({ cause }));
    if (saved instanceof Error) setError(saved.message);
  }
  return (
    <MauiProvider>
      <Padding xy={8}>
        <Flex column gap={4}>
          <H1>{title}</H1>
          <Flex row gap={2}>
            <TextField
              aria-label="New task"
              value={label}
              onChange={setLabel}
            />
            <Button
              disabled={label.trim().length === 0}
              onClick={async () => {
                await save({
                  id: crypto.randomUUID(),
                  label: label.trim(),
                  done: false,
                });
                setLabel("");
              }}
            >
              Add task
            </Button>
          </Flex>
          <Table aria-label="Tasks">
            <TableHeader>
              <TableHead isRowHeader>Task</TableHead>
              <TableHead>Status</TableHead>
            </TableHeader>
            <TableBody
              renderEmptyState={() => (
                <Text color="lowContrast">No tasks yet.</Text>
              )}
            >
              {tasks.map((task) => (
                <TableRow key={task.id} id={task.id}>
                  <TableCell>
                    <Checkbox
                      label={task.label}
                      checked={task.done}
                      setChecked={async (done) => {
                        await save({ ...task, done });
                      }}
                    />
                  </TableCell>
                  <TableCell>{task.done ? "Done" : "Open"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {error === undefined ? undefined : <Text role="alert">{error}</Text>}
        </Flex>
      </Padding>
    </MauiProvider>
  );
}
