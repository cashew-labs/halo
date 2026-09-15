import { iconSizeValues, type IconSize } from "maui";
import { style, useStyles } from "purse-styles";
import googleLogoUrl from "./assets/google.svg";

type BrandDefinition = {
  logoUrl: string;
  buttonColor: `#${string}`;
  buttonForeground: `#${string}`;
};

export const brands = {
  google: {
    logoUrl: googleLogoUrl,
    buttonColor: "#1A73E8",
    buttonForeground: "#FFFFFF",
  },
} satisfies Record<string, BrandDefinition>;

type Brand = keyof typeof brands;

export function BrandLogo(props: { brand: Brand; size: IconSize }) {
  const className = useStyles(logo);
  const box = iconSizeValues[props.size];

  return (
    <img
      src={brands[props.brand].logoUrl}
      alt=""
      aria-hidden="true"
      className={className}
      style={{ width: box, height: box }}
    />
  );
}

const logo = style({
  display: "block",
  objectFit: "contain",
  flexShrink: 0,
});
