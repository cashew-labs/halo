import { useEffect, useRef, useState } from "react";
import type { AgentAvatar } from "@get-halo/client";
import {
  mountAvatar,
  type AvatarOptions,
  type MountedAvatar,
} from "open-bot-avatar/dom";

const straight = { x: 0, y: 0 };

// Adapted from the open-bot-avatar README; the package ships no React component.
export function BotAvatar({
  avatar,
  size,
  className,
  followPointer = false,
  ...options
}: Omit<AvatarOptions, "definition" | "color" | "lookAt"> & {
  avatar: AgentAvatar;
  size: number;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedAvatar>(undefined);
  const hasPointer = usePointerInWindow(followPointer);
  // Without a look target the renderer lets the eyes wander, so face forward instead.
  const following = followPointer && !options.still && hasPointer;

  // mountAvatar redraws only the options that changed.
  useEffect(() => {
    const next = {
      ...options,
      ...avatar,
      followPointer,
      lookAt: following ? undefined : straight,
    };
    if (mounted.current === undefined)
      mounted.current = mountAvatar(host.current!, next);
    else mounted.current.update(next);
  });

  useEffect(
    () => () => {
      mounted.current?.destroy();
      mounted.current = undefined;
    },
    [],
  );

  return (
    <div
      ref={host}
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

function usePointerInWindow(enabled: boolean) {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const enter = () => setInside(true);
    // Leaving the window shows up as an `out` with no related target.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) setInside(false);
    };
    const leave = () => setInside(false);
    window.addEventListener("pointermove", enter, { passive: true });
    window.addEventListener("pointerout", out);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("pointermove", enter);
      window.removeEventListener("pointerout", out);
      window.removeEventListener("blur", leave);
    };
  }, [enabled]);
  return enabled && inside;
}
