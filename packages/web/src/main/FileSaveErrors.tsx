import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Stream } from "@get-halo/shared/Stream";

export type FileSaveError = {
  id: string;
  path: string;
  message: string;
  retry(): Promise<void>;
};

class FileSaveErrors {
  private errors: FileSaveError[] = [];
  private readonly changes = new Stream<void>();

  subscribe = (listener: () => void) => this.changes.subscribe(listener);
  getSnapshot = () => this.errors;

  report(error: FileSaveError) {
    this.errors = [
      ...this.errors.filter((entry) => entry.id !== error.id),
      error,
    ];
    this.changes.append();
  }

  clear(id: string) {
    if (!this.errors.some((entry) => entry.id === id)) return;
    this.errors = this.errors.filter((entry) => entry.id !== id);
    this.changes.append();
  }
}

const FileSaveErrorsContext = createContext<FileSaveErrors>(undefined!);

export function FileSaveErrorsProvider({ children }: { children: ReactNode }) {
  const [service] = useState(() => new FileSaveErrors());
  return (
    <FileSaveErrorsContext value={service}>{children}</FileSaveErrorsContext>
  );
}

export function useFileSaveErrors() {
  const service = useContext(FileSaveErrorsContext);
  const errors = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return { service, errors };
}
