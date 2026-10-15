import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

/** Gateway-owned chrome works for existing publications without rebuilding them. */
export function publicAppPage(ctx: {
  response: ServerResponse;
  url: URL;
  displayName: string;
  publicOrigin: string;
  head: boolean;
}) {
  const nonce = crypto.randomBytes(18).toString("base64");
  const logo = new URL("/halo-donut-transparent.png", ctx.publicOrigin);
  ctx.response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${logo.origin}; frame-src 'self'; form-action https://buttondown.com https://gethalo.dev; base-uri 'none'`,
  });
  if (ctx.head) {
    ctx.response.end();
    return;
  }
  ctx.response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(ctx.displayName)}</title>
<link rel="icon" href="${escape(logo.href)}">
<style>
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;height:100%;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202024;background:#fff}
body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.banner{flex:none;background:#f3f0fc;border-bottom:1px solid #e8e3f4;padding:8px 20px;font-size:13px;line-height:20px}
.row{display:flex;align-items:center;justify-content:center;gap:20px;max-width:1200px;margin:auto}
.intro{display:flex;align-items:center;gap:8px;white-space:nowrap}.logo{display:block;width:26px;height:26px;object-fit:contain}.intro strong{font-weight:600}
form{display:flex;align-items:center;gap:8px;min-width:0}input,button{font:inherit;height:32px;border-radius:5px}
input{width:200px;min-width:0;border:1px solid #d9d5e3;background:white;padding:5px 10px;color:#202024}
input::placeholder{color:#73707d}button{border:1px solid #24212b;background:#24212b;color:#fff;padding:5px 12px;font-weight:500;white-space:nowrap;cursor:pointer}
button:hover{background:#393440}input:focus-visible,button:focus-visible{outline:2px solid #6055be;outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.short{display:none}.status{margin:0;color:#4c465e}.status:empty{display:none}.app{display:block;flex:1;width:100%;min-height:0;border:0;background:#fff}
@media(max-width:640px){.banner{padding:8px 12px}.row{flex-wrap:wrap;justify-content:flex-start;gap:6px}.intro{width:100%;gap:6px}.logo{width:22px;height:22px}form{width:100%;gap:6px}input{width:0;flex:1;height:34px;font-size:16px}button{height:34px}.long{display:none}.short{display:inline}.status{width:100%}}
@media(prefers-color-scheme:dark){html,body,.app{color:#eeecf5;background:#19171e}.banner{background:#262131;border-color:#393144}.status{color:#d3ccdf}input{background:#19171e;border-color:#554a63;color:#eeecf5}input::placeholder{color:#b4acbf}button{background:#eeebf7;border-color:#eeebf7;color:#262131}button:hover{background:#dcd6ec}}
</style></head><body>
<aside class="banner" aria-label="Halo private alpha">
<div class="row"><div class="intro"><img class="logo" src="${escape(logo.href)}" alt="Halo"><strong>Halo is in private alpha.</strong></div>
<form aria-label="Join the Halo waitlist" method="post" action="https://buttondown.com/api/emails/embed-subscribe/halo" target="_blank" rel="noopener noreferrer">
<input type="email" name="email" aria-label="Email address" placeholder="Email address" autocomplete="email" required maxlength="254">
<input type="hidden" name="embed" value="1">
<button type="submit" aria-label="Sign up for the waitlist" aria-describedby="signup-note"><span class="long">Sign up for the waitlist</span><span class="short">Join waitlist</span></button>
<span id="signup-note" class="sr-only">Signup opens in a new tab.</span>
</form><p class="status" role="status" aria-live="polite"></p></div></aside>
<iframe class="app" title="${escape(ctx.displayName)}" src="${escape(ctx.url.pathname + ctx.url.search)}" allow="fullscreen; geolocation; camera; microphone; clipboard-read; clipboard-write" allowfullscreen></iframe>
<script nonce="${nonce}">
const form = document.querySelector('form');
const status = document.querySelector('.status');
const frame = document.querySelector('.app');
if (location.hash) frame.src += location.hash;
form.addEventListener('submit', () => {
  status.textContent = 'Finish signing up in the new tab.';
});
</script></body></html>`);
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
