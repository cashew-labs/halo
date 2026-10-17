import { useContext as useReactContext } from "react";
import { IncompatibleServerError } from "@get-halo/client";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import { ConnectionPage } from "./ConnectionPage.js";
import { Button, P, Prose } from "maui";
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
import { NewsletterStatusPage } from "./NewsletterStatusPage.js";
import { SignInPage } from "./SignInPage.tsx";
import { FullscreenPage } from "./FullscreenPage.js";

type AuthenticationState =
  | { status: "checking" }
  | { status: "unavailable"; error: Error }
  | { status: "signedOut"; error?: string }
  | { status: "signingIn" }
  | { status: "signedIn"; session: ControlPlaneSession };

type Account = {
  session: ControlPlaneSession;
  signOut: () => Promise<void | Error>;
};

const AccountContext = createContext<Account | undefined>(undefined);

const ReauthenticateContext = createContext<() => Promise<boolean | Error>>(
  async () => false,
);
export function useReauthenticate() {
  return useReactContext(ReauthenticateContext);
}

export function useAuthenticatedUserId() {
  return useContext(AccountContext)!.session.user.id;
}

/** The signed-in account, and sign out back to the signed-out screen. */
export function useAccount() {
  return useContext(AccountContext)!;
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
          : { status: "signedIn", session },
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
    if (session === undefined) return false;
    setState({ status: "signedIn", session });
    return true;
  };
  const signOut = async () => {
    const result = await host.signOut();
    if (result instanceof Error) return result;
    setState({ status: "signedOut" });
  };
  if (host.showLandingPage === true) {
    if (window.location.pathname === "/newsletter/check-email")
      return <NewsletterStatusPage status="check-email" />;
    if (window.location.pathname === "/newsletter/joined")
      return <NewsletterStatusPage status="joined" />;
  }
  if (
    host.showLandingPage === true &&
    window.location.pathname === "/" &&
    (state.status === "checking" || state.status === "signedOut")
  )
    return <LandingPage />;
  if (state.status === "checking")
    return <LoadingPage progressLabel="Loading Halo" />;
  if (state.status === "unavailable")
    return state.error instanceof IncompatibleServerError ? (
      <ConnectionPage
        error={state.error}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    ) : (
      <FullscreenPage>
        <Prose size="sm">
          <P>
            Couldn't check your sign-in status. Try again or wait for Halo to
            retry.
          </P>
        </Prose>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </FullscreenPage>
    );
  if (state.status === "signedIn")
    return (
      <AccountContext
        key={state.session.user.id}
        value={{ session: state.session, signOut }}
      >
        <ReauthenticateContext value={reauthenticate}>
          {children}
        </ReauthenticateContext>
      </AccountContext>
    );

  const signIn = async () => {
    setState({ status: "signingIn" });

    const session = await host.signIn();

    if (session instanceof Error) {
      console.warn(session);
      setState({
        status: "signedOut",
        error: "Couldn't sign in with Google. Try again.",
      });
      return;
    }
    if (session === undefined) {
      setState({ status: "signedOut" });
      return;
    }

    setState({ status: "signedIn", session });
  };

  return (
    <SignInPage
      error={state.status === "signedOut" ? state.error : undefined}
      signingIn={state.status === "signingIn"}
      onSignIn={signIn}
    />
  );
}
