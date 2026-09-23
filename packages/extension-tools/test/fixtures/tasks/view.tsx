import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Flex,
  H1,
  MauiProvider,
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
import type extension from "./extension.js";
import type { relations, schema } from "./schema.js";

class TasksError extends errore.createTaggedError({
  name: "TasksError",
  message: "Task operation failed",
}) {}

const project = { id: "launch", name: "Launch" };
const tasksQuery = {
  collection: "tasks",
  with: { project: true },
} as const;

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export default function Tasks({
  api,
  storage,
}: ExtensionViewProps<typeof extension, typeof schema, typeof relations>) {
  const [title, setTitle] = useState("Tasks");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const tasks = useQuery(storage, tasksQuery);
  useEffect(() => {
    void api.title
      .$get()
      .then(async (response) => await response.json())
      .then(({ title }) => setTitle(title))
      .catch((cause) => setError(new TasksError({ cause }).message));
  }, [api]);
  async function save(task: {
    id: string;
    projectId: string;
    label: string;
    done: boolean;
  }) {
    const tx = storage.transact();
    tx.set("projects", project);
    tx.set("tasks", task);
    const saved = await storage
      .commit(tx)
      .catch((cause) => new TasksError({ cause }));
    if (saved instanceof Error) setError(saved.message);
  }
  return (
    <MauiProvider>
      <Flex column gap={4} p={8}>
        <H1>{title}</H1>
        <Flex row gap={2}>
          <TextField aria-label="New task" value={label} onChange={setLabel} />
          <Button
            isDisabled={label.trim().length === 0}
            onClick={async () => {
              await save({
                id: crypto.randomUUID(),
                projectId: project.id,
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
            <TableHead>Project</TableHead>
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
                      await save({
                        id: task.id,
                        projectId: task.projectId,
                        label: task.label,
                        done,
                      });
                    }}
                  />
                </TableCell>
                <TableCell>
                  {task.project === null ? "No project" : task.project.name}
                </TableCell>
                <TableCell>{task.done ? "Done" : "Open"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {error === undefined ? undefined : <Text role="alert">{error}</Text>}
      </Flex>
    </MauiProvider>
  );
}
