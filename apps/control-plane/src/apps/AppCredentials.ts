import crypto from "node:crypto";

const tokenPattern =
  /^halo_app_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([1-9][0-9]{0,8})_([A-Za-z0-9_-]{43})$/;

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

  /** Returns the claimed app; callers must still check its current generation. */
  read(authorization: string | undefined) {
    if (authorization === undefined || !authorization.startsWith("Bearer "))
      return undefined;
    const match = tokenPattern.exec(authorization.slice("Bearer ".length));
    if (match === null) return undefined;
    const appId = match[1]!;
    const generation = Number(match[2]);
    const expected = Buffer.from(this.mac({ appId, generation }));
    const actual = Buffer.from(match[3]!);
    if (!crypto.timingSafeEqual(expected, actual)) return undefined;
    return { appId, generation };
  }

  private mac(ctx: { appId: string; generation: number }) {
    return crypto
      .createHmac("sha256", this.key)
      .update(`${ctx.appId}:${ctx.generation}`)
      .digest("base64url");
  }
}
