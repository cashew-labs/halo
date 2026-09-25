import { useContext as useReactContext } from "react";
import { IncompatibleServerError } from "@get-halo/client";
import { ConnectionPage } from "./ConnectionPage.js";
import { Button } from "maui";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactElement,
} from "react";
import { useHost } from "./HostProvider.js";
import { LoadingPage } from "./LoadingPage.tsx";
import { LandingPage } from "./LandingPage.js";
import { SignInPage } from "./SignInPage.tsx";

type AuthenticationState =
  | { status: "checking" }
  | { status: "unavailable"; error: Error }
  | { status: "signedOut"; error?: string }
  | { status: "signingIn" }
  | { status: "signedIn"; userId: string };

const AuthenticatedUserContext = createContext<string | undefined>(undefined);

const ReauthenticateContext = createContext<() => Promise<void | Error>>(
  async () => undefined,
);
export function useReauthenticate() {
  return useReactContext(ReauthenticateContext);
}

export function useAuthenticatedUserId() {
  return useContext(AuthenticatedUserContext)!;
}

export function Authentication({ children }: { children: ReactElement }) {
  const host = useHost();
  const [state, setState] = useState<AuthenticationState>({
    status: "checking",
  });

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const check = async () => {
      const session = await host.getAuthSession();
      if (!active) return;
      if (session instanceof Error) {
        setState({ status: "unavailable", error: session });
        return;
      }
      setState(
        session === undefined
          ? { status: "signedOut" }
          : { status: "signedIn", userId: session.user.id },
      );
    };
    void check().catch(console.error);
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit retry counter reruns session discovery after startup failures.
  }, [host, attempt]);
  useEffect(() => {
    if (state.status !== "unavailable") return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), 15_000);
    return () => clearTimeout(timer);
  }, [state]);

  const reauthenticate = async () => {
    const session = await host.signIn();
    if (session instanceof Error) return session;
    if (session !== undefined)
      setState({ status: "signedIn", userId: session.user.id });
  };
  if (state.status === "checking") return <LoadingPage />;
  if (state.status === "unavailable")
    return (
      <>
        {state.error instanceof IncompatibleServerError ? (
          <ConnectionPage status="incompatible" error={state.error} />
        ) : (
          <p>Halo cannot reach its sign-in service. Retrying automatically.</p>
        )}
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Retry now
        </Button>
      </>
    );
  if (state.status === "signedIn")
    return (
      <AuthenticatedUserContext key={state.userId} value={state.userId}>
        <ReauthenticateContext value={reauthenticate}>
          {children}
        </ReauthenticateContext>
      </AuthenticatedUserContext>
    );

  if (
    state.status === "signedOut" &&
    host.showLandingPage === true &&
    window.location.pathname === "/"
  )
    return <LandingPage />;

  const signIn = async () => {
    setState({ status: "signingIn" });

    const session = await host.signIn();

    if (session instanceof Error) {
      console.warn(session);
      setState({
        status: "signedOut",
        error: "Halo couldn't sign you in. Try again.",
      });
      return;
    }
    if (session === undefined) return;

    setState({ status: "signedIn", userId: session.user.id });
  };

  return (
    <SignInPage
      error={state.status === "signedOut" ? state.error : undefined}
      signingIn={state.status === "signingIn"}
      onSignIn={signIn}
    />
  );
}
