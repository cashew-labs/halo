---
name: testing
description: Choose, write, and review tests that exercise real consumer behavior, prioritize successful workflows, and give each test distinct coverage. Use when adding, changing, or reviewing Vitest tests, Playwright end-to-end tests, or their harnesses.
---

# Testing

Use Vitest for service, API, and library E2Es, and Playwright for UI E2Es. These
rules apply to Halo. See [the architecture guide](../../../docs/architecture.md#test-each-package-through-one-e2e-fixture)
for package boundaries and the current migration gaps.

## Package boundary and test entry

Test each package's behavior end to end through its actual consumer boundary.
E2E describes the boundary, not the runner. A server test uses HTTP/RPC; a library
test uses the public API and observes its output. Neither requires the whole app.

Use one canonical E2E fixture and test entry per package. Control-plane auth,
routing, proxying, and lifecycle tests all use `controlPlane`; do not create a
separate `AuthService` fixture. Tests may have separate feature files. Compose
helper modules, external drivers, extra clients, lifecycle controls, and lazy
setup behind the same fixture. Do not export feature-specific `test.extend(...)`
variants or replace internal sub-services. Existing fixture splits are migration
work, not examples to copy. Preserve meaningful coverage when consolidating them.

## Narrow unit-test exception

Allow direct tests only for a small, encapsulated component with a contract that
could stand as its own package, such as an interesting data structure. Name that
contract and the trigger for extraction. When the component outgrows its scope or
another package needs it, extract it; its tests become the new package's E2Es.
An ordinary parser, reducer, or helper does not qualify merely because it is pure,
exported, or convenient to isolate. Do not expose internals just to test them.

## Consumer workflows

- Services are code programs and modules to be tested. Services can compose multiple sub-services. E.g. electron app is a service that uses the renderer and main process as sub-services.
- Services receive events in, and emit events out.
- A driver of a service sends events in, and expects some events out.
  - An API request a server returns some response
  - Clicking on a link in the app opens the page
- Tests are meant to test a service. Services can theoretically be used in multiple different ways:
  - a human is driving the service
  - an agent is driving the service
  - the service is being used programmatically (code is driving the service)
  - the test is driving the service
- In all scenarios, the service should be used identically, so we know the tests are representative of real usage. Importantly, this means: the behavior of a service during a test should be as identical as possible to other situations:
  - Do not mock internal services. Use real local dependencies and control
    unavailable external providers, such as OAuth or inference, at their boundary
    through the canonical fixture.
  - Minimize test-specific configuration of the service under test.
- Tests are generally composed of 3 phases: setup, action, assertion
  - Setup: Service is driven into the state being tested. Previous tests cover correctness of these actions
  - Action: an action is taken on the service
  - Assertion: we verify the service and external state is as we expect
- Tests should read as clear workflows: setup, actions, and expected outcomes. Keep setup and test configuration local when they help explain the test.
- Keep the service's consumer API visible through the canonical fixture.
- Tests should be isolated and unique. They should not re-test correctness already verified in other tests.
- Services can be made up of sub-services. Tests should not test the data flow internally between sub-services - these are considered implementation details. Only test the externally visible outcomes.
  - Examples of implementation details:
    - Asserting a server sends a specific request to another server - just test the response back to the driver
    - Asserting it updates an internal database with specific rows - instead, ask if it did update properly, what end-driver outcome could we measure/see?
  - Examples of externally visible outcomes
    - Asserting that a file is really deleted in the filesystem after deleting it in the app. The filesystem is not an implementation detail if the driver expects to interact with it not through the app. But if the filesystem is being used to store an internal db that’s not meant to be directly used by drivers, then it would be considered an implementation detail.
- The fixtures available to a test code driver should be the following
  - The service being tested, able to send events to it at the same fidelity as other drivers.
    - E.g. for a web page, this might be the playwright page. For a server, it’s the ability to directly call routes.
  - External services that should be visible to the driver. Examples:
    - For sync engine, this could be a timer object, and a secondary client
    - For web pages, it could be a second client/browser to load the same web page and assert some change propagated
  - Different drivers (like code, human, agent) might have different external services exposed to them. The test should contain the union of these. Don’t add external services that might plausibly be used by other drivers, until we decide behavior on those services should be tested.
