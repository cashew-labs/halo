import { colors, radius, spacing } from "maui";
import { style } from "purse-styles";

/** Chip treatment for inline `code` marks. */
export const proseInlineCode = style(
  radius.md,
  spacing.padding({ x: 2, y: 1 }),
  {
    backgroundColor: colors.gray[4],
  },
);
