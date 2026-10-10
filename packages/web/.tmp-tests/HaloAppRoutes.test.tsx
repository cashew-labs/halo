import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import type { HostApi } from "../src/HostApi.ts";

vi.mock("agentation", () => ({ Agentation: () => null }));
vi.mock("../src/Authentication.tsx", () => ({
  Authentication: ({ children }: { children: ReactNode }) => (
    <section data-auth="">{children}</section>
  ),
}));
vi.mock("../src/api/ApiProvider.tsx", () => ({
  ApiProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../src/HaloApp.tsx", () => ({ HaloApp: () => <p>app</p> }));
vi.mock("../src/StandaloneExtension.js", () => ({
  StandaloneExtension: ({ extensionId }: { extensionId: string }) => (
    <p>extension {extensionId}</p>
  ),
}));
vi.mock("../src/IntegrationSetupPage.js", () => ({
  IntegrationSetupPage: ({ setupId }: { setupId: string }) => (
    <p>setup {setupId}</p>
  ),
}));

const { HaloAppRoutes } = await import("../src/HaloAppRoutes.tsx");

function render(path: string, host: Partial<HostApi>) {
  return renderToStaticMarkup(
    <Router ssrPath={path}>
      <HaloAppRoutes host={host as HostApi} />
    </Router>,
  );
}

const setupHost = { integrationSetup: {} as HostApi["integrationSetup"] };

test("setup pages render without the sign-in gate", () => {
  const html = render("/integrations/setup/abc", setupHost);
  expect(html).toBe("<p>setup abc</p>");
});

test("every other route stays behind the sign-in gate", () => {
  expect(render("/", setupHost)).toBe('<section data-auth=""><p>app</p></section>');
  expect(render("/extensions/a%20b", setupHost)).toBe(
    '<section data-auth=""><p>extension a b</p></section>',
  );
  // Hosts without setup support keep the setup path behind the gate too.
  expect(render("/integrations/setup/abc", {})).toBe(
    '<section data-auth=""><p>app</p></section>',
  );
});
