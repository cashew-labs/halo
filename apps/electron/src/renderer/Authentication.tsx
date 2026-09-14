import { useEffect, useState, type ReactElement } from "react";
import * as errore from "errore";
import { LoadingPage } from "./LoadingPage.tsx";
import { SignInPage } from "./SignInPage.tsx";
import { hostApi } from "./api/host.ts";

class AuthenticationError extends errore.createTaggedError({
  name: "AuthenticationError",
  message: "Halo could not $operation",
}) {}

type AuthenticationState =
  | { status: "checking" }
  | { status: "signedOut"; error?: string }
  | { status: "signingIn" }
  | { status: "signedIn" };

export function Authentication({ children }: { children: ReactElement }) {
  const [state, setState] = useState<AuthenticationState>({
    status: "checking",
  });

  useEffect(() => {
    let active = true;

    hostApi.getAuthSession().then(
      (session) => {
        if (!active) return;

        setState({
          status: session === undefined ? "signedOut" : "signedIn",
        });
      },
      (cause) => {
        if (!active) return;

        console.warn(
          new AuthenticationError({
            operation: "restore your sign-in",
            cause,
          }),
        );
        setState({
          status: "signedOut",
          error: "Halo couldn't restore your sign-in. You can sign in again.",
        });
      },
    );

    return () => {
      active = false;
    };
  }, []);

  if (state.status === "checking") return <LoadingPage />;
  if (state.status === "signedIn") return children;

  const signIn = async () => {
    setState({ status: "signingIn" });

    const session = await hostApi
      .signIn()
      .catch(
        (cause) => new AuthenticationError({ operation: "sign you in", cause }),
      );

    if (session instanceof Error) {
      console.warn(session);
      setState({
        status: "signedOut",
        error: "Halo couldn't sign you in. Try again.",
      });
      return;
    }

    setState({ status: "signedIn" });
  };

  return (
    <SignInPage
      error={state.status === "signedOut" ? state.error : undefined}
      signingIn={state.status === "signingIn"}
      onSignIn={signIn}
    />
  );
}
