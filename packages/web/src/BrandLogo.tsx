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
