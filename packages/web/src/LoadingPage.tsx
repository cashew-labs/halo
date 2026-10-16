import type { ReactNode } from "react";
import { LoadingScreen } from "maui";
import { FullscreenPage } from "./FullscreenPage.js";

export function LoadingPage({
  progressLabel,
  children,
}: {
  progressLabel: string;
  children?: ReactNode;
}) {
  return (
    <FullscreenPage visual={<LoadingScreen progressLabel={progressLabel} />}>
      {children}
    </FullscreenPage>
  );
}
