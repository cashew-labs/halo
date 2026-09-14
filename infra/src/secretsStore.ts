import * as Cloudflare from "alchemy/Cloudflare";

export const secretsStore = Cloudflare.SecretsStore.Store("SecretsStore");
