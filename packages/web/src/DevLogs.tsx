import { Flex, Link, P, Text, text } from "maui";
import { style, useStyles } from "purse-styles";

export function DevLogs({ showHeading = true }: { showHeading?: boolean }) {
  const heading = useStyles(styles.heading);

  return (
    <section
      aria-labelledby={showHeading ? "dev-logs-heading" : undefined}
      aria-label={showHeading ? undefined : "Dev Logs"}
    >
      <Flex column gap={6}>
        {showHeading && (
          <h2 id="dev-logs-heading" className={heading}>
            Dev Logs
          </h2>
        )}
        <P>
          <Text tabular>0001</Text> -{" "}
          <Link href="https://youtu.be/bTsJFEPTkYQ">
            The Personal Computing Revolution Hasn&apos;t Happened Yet.
          </Link>
        </P>
      </Flex>
    </section>
  );
}

const styles = {
  heading: style(text({ size: "md", fontWeight: 500, color: "lowContrast" }), {
    margin: 0,
  }),
};
