import type { AgentAvatar } from "@get-halo/client";
import { Flex, backgroundColor, colors, focusRing, radius } from "maui";
import { examples } from "open-bot-avatar";
import { style, useStyles } from "purse-styles";
import { Radio, RadioGroup } from "react-aria-components";
import { BotAvatar } from "./BotAvatar.js";
import { avatarGallery } from "./avatarGallery.js";

const characters = [...examples, ...avatarGallery];

// The open-bot-avatar editor's palette without white and gray.
const swatches = [
  { value: "#a8693f", name: "Brown" },
  { value: "#f2384b", name: "Red" },
  { value: "#ff6a1a", name: "Orange" },
  { value: "#f8a01c", name: "Amber" },
  { value: "#1fbf68", name: "Green" },
  { value: "#14b3a5", name: "Teal" },
  { value: "#1f7cf2", name: "Blue" },
  { value: "#8b5cf6", name: "Purple" },
  { value: "#ec4899", name: "Pink" },
];

export function randomAvatar(): AgentAvatar {
  return {
    definition: characters[Math.floor(Math.random() * characters.length)]!,
    color: swatches[Math.floor(Math.random() * swatches.length)]!.value,
  };
}

export function AvatarPicker({
  avatar,
  onChange,
  isDisabled,
}: {
  avatar: AgentAvatar;
  onChange(avatar: AgentAvatar): void;
  isDisabled?: boolean;
}) {
  const characterGrid = useStyles(styles.characterGrid);
  const characterOption = useStyles(styles.option, radius.md, focusRing());
  const swatchRow = useStyles(styles.swatchRow);
  const swatchOption = useStyles(styles.option, radius.circle, focusRing());
  const swatch = useStyles(styles.swatch, radius.circle);
  return (
    <Flex column gap={8}>
      <RadioGroup
        aria-label="Avatar"
        orientation="horizontal"
        className={characterGrid}
        value={avatar.definition.id}
        isDisabled={isDisabled}
        onChange={(id) => {
          const definition = characters.find(
            (character) => character.id === id,
          );
          if (definition !== undefined) onChange({ ...avatar, definition });
        }}
      >
        {characters.map((character) => (
          <Radio
            key={character.id}
            value={character.id}
            aria-label={character.name}
            className={characterOption}
          >
            <BotAvatar
              avatar={{ definition: character, color: avatar.color }}
              size={32}
              still
              label=""
            />
          </Radio>
        ))}
      </RadioGroup>
      <RadioGroup
        aria-label="Color"
        orientation="horizontal"
        className={swatchRow}
        value={avatar.color}
        isDisabled={isDisabled}
        onChange={(color) => onChange({ ...avatar, color })}
      >
        {swatches.map(({ value, name }) => (
          <Radio
            key={value}
            value={value}
            aria-label={name}
            className={swatchOption}
          >
            <span className={swatch} style={{ backgroundColor: value }} />
          </Radio>
        ))}
      </RadioGroup>
    </Flex>
  );
}

const styles = {
  characterGrid: style({
    display: "grid",
    gridTemplateColumns: "repeat(8, 1fr)",
    justifyItems: "center",
    rowGap: "4px",
  }),
  swatchRow: style({
    display: "flex",
    justifyContent: "center",
    gap: "6px",
    // Room for the selection ring inside the scrolling dialog body.
    paddingBottom: "2px",
  }),
  // A ring marks the selected option, like the Grok and open-bot-avatar pickers.
  option: style({
    display: "grid",
    placeItems: "center",
    padding: "4px",
    cursor: "pointer",
    "&[data-hovered]": { backgroundColor: backgroundColor.elementHover },
    "&[data-selected]": { boxShadow: `0 0 0 2px ${colors.gray[8]}` },
    "&[data-disabled]": { cursor: "default", opacity: 0.6 },
  }),
  swatch: style({ width: "22px", height: "22px" }),
};
