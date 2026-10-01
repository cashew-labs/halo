import { useCallback, useEffect, useState } from "react";

type AsyncState<T> = {
  fetching: boolean;
  spinner: boolean;
  data: T | undefined;
  error: Error | undefined;
};

// Pass a useCallback-stable read; changing it starts a new request lifecycle.
export function useAsyncData<T>(
  read: () => Promise<T | Error>,
  { enabled = true, refreshMs }: { enabled?: boolean; refreshMs?: number } = {},
) {
  const [state, setState] = useState<AsyncState<T>>({
    fetching: enabled,
    spinner: false,
    data: undefined,
    error: undefined,
  });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    let spinnerTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    // oxlint-disable-next-line react/set-state-in-effect -- Starting an external read resets the previous request's result and loading state.
    setState({
      fetching: enabled,
      spinner: false,
      data: undefined,
      error: undefined,
    });
    if (!enabled) return;

    async function run() {
      setState((current) => ({ ...current, fetching: true, spinner: false }));
      spinnerTimer = setTimeout(() => {
        if (active) setState((current) => ({ ...current, spinner: true }));
      }, 300);
      const result = await read();
      if (!active) return;
      clearTimeout(spinnerTimer);
      setState((current) =>
        result instanceof Error
          ? { ...current, fetching: false, spinner: false, error: result }
          : { fetching: false, spinner: false, data: result, error: undefined },
      );
      if (refreshMs !== undefined)
        pollTimer = setTimeout(
          () => void run().catch(console.error),
          refreshMs,
        );
    }
    void run().catch(console.error);
    return () => {
      active = false;
      clearTimeout(spinnerTimer);
      clearTimeout(pollTimer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit refresh starts a new request and cancels the previous lifecycle.
  }, [read, enabled, refreshMs, revision]);

  return { ...state, refresh };
}
