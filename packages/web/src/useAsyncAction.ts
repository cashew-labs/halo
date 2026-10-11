import { useEffect, useRef, useState } from "react";

export function useAsyncAction(action: () => Promise<void | Error>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const active = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function run() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    const result = await action();
    running.current = false;
    if (!active.current) return;
    setPending(false);
    if (result instanceof Error) {
      console.warn("Action failed:", result);
      setError(result);
    }
  }
  return { run, pending, error };
}
