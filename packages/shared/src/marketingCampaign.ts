import { Type, type Static } from "@sinclair/typebox";

export const marketingSlugSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
});
const tag = Type.String({ minLength: 1, maxLength: 512, pattern: "\\S" });
export const marketingTagsSchema = Type.Object(
  {
    utm_source: tag,
    utm_medium: tag,
    utm_campaign: tag,
    utm_content: Type.Optional(tag),
    utm_term: Type.Optional(tag),
  },
  { additionalProperties: false },
);
export const marketingCampaignSchema = Type.Object(
  {
    slug: marketingSlugSchema,
    tags: marketingTagsSchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MarketingCampaign = Static<typeof marketingCampaignSchema>;
