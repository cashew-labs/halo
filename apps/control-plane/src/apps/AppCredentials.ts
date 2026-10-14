import crypto from "node:crypto";

/**
 * App VM runtime tokens. Each token names one app and credential generation and
 * carries a MAC under a key derived only for apps, so it can never verify as a
 * workspace or owner credential. Rotating the generation revokes old tokens.
 */
export class AppCredentials {
  private readonly key: Buffer;

  constructor(ctx: { secret: string }) {
    this.key = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        ctx.secret,
        "halo-control-plane",
        "app-runtime-token",
        32,
      ),
    );
  }

  issue(ctx: { appId: string; generation: number }) {
    return `halo_app_${ctx.appId}_${ctx.generation}_${this.mac(ctx)}`;
  }

  private mac(ctx: { appId: string; generation: number }) {
    return crypto
      .createHmac("sha256", this.key)
      .update(`${ctx.appId}:${ctx.generation}`)
      .digest("base64url");
  }
}
