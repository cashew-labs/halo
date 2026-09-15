import { useEffect, useRef } from "react";

export function useRefCurrent<T>(value: T) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}
