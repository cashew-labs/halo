import type { ExtensionHttpHandler } from "@get-halo/extension-sdk/server";
const http: ExtensionHttpHandler = (request) => {
  if (new URL(request.url).pathname !== "/launch")
    return new Response(undefined, { status: 404 });
  return Response.redirect("https://gethalo.dev/?utm_source=launch", 302);
};
// oxlint-disable-next-line anti-slop/no-unused-exports -- The generated server entry imports this optional fixture module.
export default http;
