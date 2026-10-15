import { Agent, fetch as undiciFetch } from "undici";

/**
 * A minimal browser for creator hosts: resolves every *.localhost name to the
 * loopback server, keeps cookies per host, and sends Origin like a browser.
 */
export class Browser {
  readonly cookies = new Map<string, Map<string, string>>();
  private readonly dispatcher = new Agent({ connect: { lookup: (_host: string, options: { all?: boolean }, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4) } });

  setCookies(host: string, header: string | null) {
    if (header === null) return;
    const jar = this.cookies.get(host) ?? new Map<string, string>();
    for (const part of header.split(/;\s*/)) {
      const [name, ...value] = part.split("=");
      if (name) jar.set(name.trim(), value.join("="));
    }
    this.cookies.set(host, jar);
  }

  async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; origin?: string } = {}) {
    const target = new URL(url);
    const jar = this.cookies.get(target.host);
    const headers: Record<string, string> = { ...init.headers };
    if (jar !== undefined && jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (init.origin !== undefined) headers.origin = init.origin;
    const response = await undiciFetch(target, { method: init.method ?? "GET", headers, body: init.body, redirect: "manual", dispatcher: this.dispatcher });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair!.split("=");
      const jarForHost = this.cookies.get(target.host) ?? new Map<string, string>();
      if (/Max-Age=0/i.test(cookie)) jarForHost.delete(name!.trim());
      else jarForHost.set(name!.trim(), value.join("="));
      this.cookies.set(target.host, jarForHost);
    }
    return response;
  }

  /** Calls an SDK oRPC procedure the way the extension view does. */
  async api(base: string, procedure: string, input?: unknown, origin = new URL(base).origin) {
    const response = await this.fetch(`${base}api/${procedure}`, { method: "POST", origin, headers: { "content-type": "application/json" }, body: JSON.stringify(input === undefined ? {} : { json: input }) });
    const text = await response.text();
    const parsed = text === "" ? undefined : (JSON.parse(text) as { json?: unknown });
    return { status: response.status, body: parsed?.json ?? parsed };
  }

  async close() {
    await this.dispatcher.close();
  }
}
