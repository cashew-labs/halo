import { useEffect, useState, type ReactElement } from "react";
import { useLocation } from "wouter";
import { useHost } from "./HostProvider.js";
import { LoadingPage } from "./LoadingPage.tsx";
import { MarketingPage } from "./MarketingPage.tsx";
import { SignInPage } from "./SignInPage.tsx";

type AuthenticationState =
  | { status: "checking" }
  | { status: "signedOut"; error?: string }
  | { status: "signingIn" }
  | { status: "signedIn" };

export function Authentication({ children }: { children: ReactElement }) {
  const host = useHost();
  const [path] = useLocation();
  const [state, setState] = useState<AuthenticationState>({
    status: "checking",
  });

  useEffect(() => {
    let active = true;

    host.getAuthSession().then(
      (session) => {
        if (!active) return;

        if (session instanceof Error) {
          console.warn(session);
          setState({
            status: "signedOut",
            error: "Halo couldn't restore your sign-in. You can sign in again.",
          });
          return;
        }

        setState({
          status: session === undefined ? "signedOut" : "signedIn",
        });
      },
      (cause) => {
        throw cause;
      },
    );

    return () => {
      active = false;
    };
  }, [host]);

  if (state.status === "checking") return <LoadingPage />;
  if (state.status === "signedIn") return children;

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

    setState({ status: "signedIn" });
  };

  if ((host.signedOutView?.(path) ?? "sign-in") === "public-site") {
    return <MarketingPage />;
  }

  return (
    <SignInPage
      error={state.status === "signedOut" ? state.error : undefined}
      signingIn={state.status === "signingIn"}
      onSignIn={signIn}
    />
  );
}
