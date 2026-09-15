import {
  Button,
  Flex,
  H1,
  P,
  backgroundColor,
  colors,
  radius,
  shadow,
  spacing,
} from "maui";
import { style, useStyles } from "purse-styles";
import type { IncompatibleServerError } from "./api/connectHaloRpc.js";

type ConnectionPageProps =
  | { status: "disconnected" | "waiting" }
  | { status: "incompatible"; error: IncompatibleServerError };

export function ConnectionPage(props: ConnectionPageProps) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);
  const incompatible = props.status === "incompatible";

  return (
    <main className={shell}>
      <section className={card}>
        <Flex column gap={8}>
          <div>
            <H1>
              {incompatible
                ? "This Halo app cannot use this server version"
                : props.status === "waiting"
                  ? "Waiting for your server"
                  : "Halo disconnected from its server"}
            </H1>
            <P>
              {incompatible
                ? `This app uses protocol ${props.error.clientProtocolVersion}, but the server uses protocol ${props.error.serverProtocolVersion}. Update Halo, then reload it.`
                : props.status === "waiting"
                  ? "Halo will connect when your server is ready."
                  : "Reload Halo to reconnect."}
            </P>
          </div>
          <Button onClick={() => window.location.reload()}>Reload Halo</Button>
        </Flex>
      </section>
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "100vh",
    backgroundColor: colors.gray[2],
  }),
  card: style(shadow.subtle, radius.lg, spacing.padding({ all: 12 }), {
    width: "min(100%, 440px)",
    minWidth: 0,
    backgroundColor: backgroundColor.element,
  }),
};
