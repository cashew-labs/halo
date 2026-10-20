import { expect, test, vi } from "vitest";
import { GoogleAppDomainTls } from "../GoogleAppDomainTls.js";

const input = {
  domainId: "dcb30bc4-df42-4b56-88e6-66cfc88cafef",
  hostname: "links.example.org",
};
const authorization = () =>
  Response.json({
    dnsResourceRecord: {
      name: "_acme-challenge.links.example.org.",
      type: "CNAME",
      data: "example.authorize.certificatemanager.goog.",
    },
  });
const active = () => Response.json({ managed: { state: "ACTIVE" } });
const missing = () => new Response(undefined, { status: 404 });
const fail = () => new Response(undefined, { status: 503 });
const cases: {
  name: string;
  responses: () => Array<Response | Error>;
  remove?: boolean;
}[] = [
  { name: "DNS authorization creation", responses: () => [missing(), fail()] },
  { name: "certificate lookup", responses: () => [authorization(), fail()] },
  {
    name: "certificate creation",
    responses: () => [authorization(), missing(), fail()],
  },
  {
    name: "map entry lookup",
    responses: () => [authorization(), active(), fail()],
  },
  {
    name: "map entry creation",
    responses: () => [authorization(), active(), missing(), fail()],
  },
  { name: "missing DNS record", responses: () => [Response.json({})] },
  { name: "network failure", responses: () => [new Error("provider offline")] },
  { name: "invalid JSON", responses: () => [new Response("not JSON")] },
  { name: "invalid schema", responses: () => [Response.json({ state: 99 })] },
  {
    name: "failed operation",
    responses: () => [
      Response.json({ error: { message: "operation failed" } }),
    ],
  },
  { name: "delete request", responses: () => [fail()], remove: true },
  {
    name: "delete poll",
    responses: () => [
      Response.json({
        name: "projects/test/locations/global/operations/1",
        done: false,
      }),
      fail(),
    ],
    remove: true,
  },
];
test.each(cases)("reports $name failure", async ({ responses, remove }) => {
  const values = responses();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("Unexpected cloud request");
    return value;
  });
  const tls = new GoogleAppDomainTls({
    auth: { getAccessToken: async () => "test-token" },
    projectId: "test-project",
    certificateMap: "halo",
    address: "192.0.2.1",
  });
  try {
    expect(
      await (remove ? tls.remove(input) : tls.ensure(input)),
    ).toBeInstanceOf(Error);
  } finally {
    spy.mockRestore();
  }
});
test("handles missing or rejected Google credentials", async () => {
  for (const getAccessToken of [
    async () => null,
    async () => {
      throw new Error("invalid credential");
    },
  ]) {
    const tls = new GoogleAppDomainTls({
      auth: { getAccessToken },
      projectId: "test-project",
      certificateMap: "halo",
      address: "192.0.2.1",
    });
    expect(await tls.ensure(input)).toBeInstanceOf(Error);
  }
});
test("retries an idempotent create conflict and accepts an empty response", async () => {
  const responses = [
    new Response(undefined, { status: 204 }),
    new Response(undefined, { status: 409 }),
  ];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => responses.shift()!);
  const tls = new GoogleAppDomainTls({
    auth: { getAccessToken: async () => "test-token" },
    projectId: "test-project",
    certificateMap: "halo",
    address: "192.0.2.1",
  });
  try {
    expect(await tls.ensure(input)).toEqual({ ready: false, records: [] });
  } finally {
    spy.mockRestore();
  }
});
