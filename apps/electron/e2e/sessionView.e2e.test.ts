import { expect, type Locator } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";

e2eTest(
  "preserves the reading position during streaming and follows again at the bottom",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Explain the plan");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    const response = await llm.stream();
    response.write(
      m.assistant(
        Array.from({ length: 50 }, (_, i) => `Plan step ${i + 1}.`).join(
          "\n\n",
        ),
      ),
    );
    await expect(transcript).toContainText("Plan step 50.");
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);

    await transcript.hover();
    await app.page.mouse.wheel(0, -400);
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeGreaterThan(300);
    const readingPosition = await transcript.evaluate(
      (element) => element.scrollTop,
    );

    for (const chunk of ["More details.", "Another update."]) {
      response.write(m.assistant(`\n\n${chunk}`));
      await expect(transcript).toContainText(chunk);
      expect(
        await transcript.evaluate((element) => element.scrollTop),
      ).toBeCloseTo(readingPosition, 0);
    }

    await app.page.mouse.wheel(0, 10_000);
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);
    response.write(m.assistant("\n\nThe final step.\n\nThe plan is ready."));
    await expect(transcript).toContainText("The plan is ready.");
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);
    response.end();
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);
  },
);

async function bottomGap(transcript: Locator) {
  return await transcript.evaluate(
    (element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

e2eTest(
  "opens another session at the bottom after reading older messages",
  async ({ app, harness }) => {
    for (const title of [
      "First long conversation",
      "Second long conversation",
    ]) {
      await harness.loadSession({
        title,
        messages: [
          m.user(title),
          m.assistant(
            Array.from({ length: 50 }, (_, i) => `Saved step ${i + 1}.`).join(
              "\n\n",
            ),
          ),
        ],
      });
    }
    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);
    await transcript.hover();
    await app.page.mouse.wheel(0, -400);
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeGreaterThan(300);

    await app.page
      .getByRole("link", { name: "First long conversation", exact: true })
      .click();
    await expect(transcript).toContainText("First long conversation");
    await expect
      .poll(async () => await bottomGap(transcript))
      .toBeLessThanOrEqual(1);
  },
);

e2eTest("starts a new session", async ({ harness, app }) => {
  await harness.loadSession({
    title: "Existing conversation",
    messages: [
      m.user("Summarize this workspace"),
      m.assistant("Here is the summary."),
    ],
  });

  await app.page
    .getByRole("button", { name: "New session", exact: true })
    .click();

  const newSession = app.page.getByRole("main", {
    name: "New session",
    exact: true,
  });
  await expect(newSession).toBeVisible();
  await expect(newSession.getByLabel("Message", { exact: true })).toBeFocused();
});

e2eTest(
  "keeps the selected session and draft pages after reload",
  async ({ harness, app }) => {
    for (const title of ["Earlier conversation", "Latest conversation"]) {
      await harness.loadSession({
        title,
        messages: [m.user(title), m.assistant("Saved reply")],
      });
    }
    await app.page
      .getByRole("link", { name: "Earlier conversation", exact: true })
      .click();
    await app.page.reload();
    await expect(
      app.page.getByRole("main", { name: "Earlier conversation" }),
    ).toBeVisible();

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const draft = app.page.getByRole("main", {
      name: "New session",
      exact: true,
    });
    await expect(draft).toBeVisible();
    await app.page.reload();
    await expect(draft).toBeVisible();
  },
);

e2eTest(
  "continues with saved messages and tool results after quitting Halo",
  async ({ app, harness, llm }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "The project mascot is a blue bicycle.",
    });
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Read the project notes");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond([
      m.assistant("I will read the notes."),
      m.tool.start("read", {
        id: "read-notes",
        arguments: { path: "notes.md" },
      }),
    ]);
    await llm.respond(m.assistant("The notes are saved."));
    await expect(app.page.getByRole("main")).toContainText(
      "The notes are saved.",
    );
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();

    await app.quit();
    await app.open();

    const pane = app.page.getByRole("main");
    const transcript = pane.getByRole("log", { name: "Session transcript" });
    await expect(
      transcript.getByText("Read the project notes", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("The notes are saved.", {
        exact: true,
      }),
    ).toBeVisible();

    await pane
      .getByLabel("Message", { exact: true })
      .fill("Continue the conversation");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) =>
      m.assistant(
        [
          `Earlier prompts: ${messages
            .filter((message) => message.role === "user")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier answers: ${messages
            .filter((message) => message.role === "assistant")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier tool results: ${messages
            .filter((message) => message.role === "tool")
            .map((message) => messageText(message))
            .join("\n")}`,
        ].join("\n\n"),
      ),
    );
    await expect(
      transcript.getByText(
        "Earlier prompts: Read the project notes → Continue the conversation",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier answers: I will read the notes. → The notes are saved.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier tool results: The project mascot is a blue bicycle.",
        { exact: true },
      ),
    ).toBeVisible();
  },
);

e2eTest(
  "answers a new message after stopping a pending model response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Start a long answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();

    await app.page.getByRole("button", { name: "Stop", exact: true }).click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Answer this instead");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(m.assistant("Here is the new answer."));

    await expect(app.page.getByRole("main")).toContainText(
      "Here is the new answer.",
    );
  },
);

e2eTest(
  "finishes a pending response while Electron is closed",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Start an answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.page.getByRole("article", { name: "You message" }),
    ).toContainText("Start an answer");

    await llm.waitForRequest();
    await app.quit();
    await llm.respond(
      m.assistant("The server finished while Electron was closed."),
    );
    await app.open();

    await expect(app.page.getByRole("main")).toContainText(
      "The server finished while Electron was closed.",
    );
  },
);

e2eTest(
  "titles a session immediately and keeps its first message when inference is denied",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const observed = await app.page.evaluateHandle(() => {
      const titles: string[] = [];
      const observer = new MutationObserver(() => {
        const title = document.querySelector(
          '[role="tab"][aria-selected="true"]',
        )?.textContent;
        if (title !== undefined && title !== null) titles.push(title);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      return { titles, observer };
    });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Keep my original question");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "Keep my original question",
    );
    await llm.respond(m.error("Model access denied"));

    await expect(pane.getByRole("alert")).toContainText("Model access denied");
    await expect(
      pane.getByRole("article", { name: "You message" }),
    ).toContainText("Keep my original question");

    await pane.getByLabel("Message", { exact: true }).fill("Try again");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(m.assistant("Ready to continue."));

    await expect(
      pane.getByRole("log", { name: "Session transcript" }),
    ).toContainText("Ready to continue.");
    await expect(pane.getByRole("alert")).not.toBeVisible();
    await expect(app.page.getByRole("tab", { selected: true })).toHaveText(
      "Keep my original question",
    );
    const [session] = await app.server.rpc.sessions.list();
    expect(session).toBeDefined();
    const observedTitles = await observed.evaluate(({ titles, observer }) => {
      observer.disconnect();
      return titles;
    });
    await observed.dispose();
    expect(observedTitles).toContain("Keep my original question");
    expect(observedTitles).not.toContain(session!.sessionId);
  },
);

const googleDriveConnection = {
  client: "first-party:google",
  clientOwner: "org",
  owner: "user",
  connectionName: "default",
  integration: "google_drive",
  template: "googleOAuth2",
} as const;

e2eTest("shows a connection request", async ({ harness, app }) => {
  await harness.loadSession({
    title: "Drive search",
    messages: [
      m.user("Find my planning document"),
      m.connectionRequest(googleDriveConnection),
    ],
  });

  const card = app.page.getByRole("region", {
    name: "Google Drive connection",
  });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Search, read, create, and share files."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect" })).toBeVisible();
  await expect(
    card.getByText("Connect your account so the agent can continue"),
  ).toHaveCount(0);
});

e2eTest(
  "starts connecting a tool from the connection card",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Drive search",
      messages: [
        m.user("Find my planning document"),
        m.connectionRequest(googleDriveConnection),
      ],
    });

    const card = app.page.getByRole("region", {
      name: "Google Drive connection",
    });
    await expect(
      card.getByText("Search, read, create, and share files."),
    ).toBeVisible();
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByText("Opened in your browser")).toBeVisible();
    await expect(
      card.getByText("Search, read, create, and share files."),
    ).toBeVisible();
    await card.getByRole("button", { name: "Google Drive actions" }).click();
    await app.page.getByRole("menuitem", { name: "Cancel" }).click();
    await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  },
);

e2eTest("shows tools used inside exec", async ({ harness, app }) => {
  const descriptionJs =
    "return await tools.describe.tool({ path: 'google_calendar.events.list' })";
  const searchJs = "return await tools.search({ query: 'web search' })";
  const lookupJs =
    "await Promise.all([tools.google_calendar.events.list({}), tools.web.search({ query: 'Halo' })])";
  await harness.loadSession({
    title: "Cross-tool lookup",
    messages: [
      m.user("Check my calendar and search the web"),
      m.exec({
        js: descriptionJs,
        tools: [{ path: "describe.tool" }],
        result: "Calendar tool schema",
      }),
      m.exec({
        js: searchJs,
        tools: [{ path: "search" }],
        result: "Web search tools found",
      }),
      m.exec({
        js: lookupJs,
        tools: [
          { path: "google_calendar.events.list" },
          { path: "web.search" },
        ],
        result: "Done",
      }),
    ],
  });

  const summary = app.page.getByRole("button", {
    name: "Searched tools and used Google Calendar, Web Search",
    exact: true,
  });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(
    app.page.getByText("Searched tools", { exact: true }),
  ).toHaveCount(2);
  await expect(
    app.page.getByText("Used Google Calendar", { exact: true }),
  ).toHaveCount(1);
  await expect(
    app.page.getByText("Used Web Search", { exact: true }),
  ).toHaveCount(1);
  await expect(app.page.getByText("Exec", { exact: true })).toHaveCount(0);
  for (const tool of [
    {
      path: "describe.tool",
      label: "Searched tools",
      js: descriptionJs,
      result: "Calendar tool schema",
    },
    {
      path: "search",
      label: "Searched tools",
      js: searchJs,
      result: "Web search tools found",
    },
    {
      path: "google_calendar.events.list",
      label: "Used Google Calendar",
      js: lookupJs,
      result: "Done",
    },
    {
      path: "web.search",
      label: "Used Web Search",
      js: lookupJs,
      result: "Done",
    },
  ]) {
    const call = app.page.getByRole("button", {
      name: `${tool.label} (${tool.path})`,
      exact: true,
    });
    await call.click();
    const details = app.page.getByRole("region", {
      name: tool.path,
      exact: true,
    });
    await expect(details.getByRole("code")).toHaveText([tool.js, tool.result]);
    await call.click();
  }
});

e2eTest(
  "wraps exec code and results in individual tool details",
  async ({ harness, app }) => {
    const query = "calendar scheduling ".repeat(25);
    const js = `return await tools.search({ query: '${query}' });`;
    const result = `https://example.com/${"calendar".repeat(80)}`;
    await harness.loadSession({
      title: "Wrapped tool details",
      messages: [
        m.exec({
          js,
          tools: [{ path: "search", arguments: { query } }],
          result,
        }),
      ],
    });
    await app.page
      .getByRole("button", { name: "Searched tools", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "Searched tools (search)", exact: true })
      .click();
    const details = app.page.getByRole("region", {
      name: "search",
      exact: true,
    });
    const code = details.getByRole("code");
    await expect(code).toHaveText([js, result]);
    await expect
      .poll(
        async () =>
          await details.evaluate((element) =>
            Array.from(element.querySelectorAll("pre")).every(
              (block) => block.scrollWidth <= block.clientWidth,
            ),
          ),
      )
      .toBe(true);
    for (const block of await code.all()) {
      await expect
        .poll(
          async () =>
            await block.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return new Set(
                Array.from(range.getClientRects(), (rect) => rect.top),
              ).size;
            }),
        )
        .toBeGreaterThan(1);
    }
  },
);

e2eTest(
  "restores nested tool activity while exec runs and after quitting",
  async ({ harness, app, llm, http }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "Read before the request",
    });
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Read the notes and fetch the report");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const command = `curl --silent --fail '${http.url("/report")}'`;
    const js = `await tools.files.read({ path: "notes.md" }); return await tools.bash.run({ command: ${JSON.stringify(command)}, timeoutMs: 60000 });`;
    await llm.respond(
      m.tool.start("exec", { id: "report", arguments: { js } }),
    );
    const request = await http.request("/report");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();

    await app.page.reload();

    const pane = app.page.getByRole("main");
    const summary = pane.getByRole("button", {
      name: "Read 1 file",
      exact: true,
    });
    await expect(summary).toBeVisible();
    await expectThinkingVisible(
      summary.getByRole("status", { name: "Working" }),
    );
    await expect(
      summary.getByRole("img", { name: "Expand tool activity" }),
    ).toBeHidden();
    await expect(
      pane.getByLabel("Active tools").getByText(`$ ${command}`, {
        exact: true,
      }),
    ).toBeVisible();
    await summary.hover();
    await expect(
      summary.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(summary.getByRole("status", { name: "Working" })).toBeHidden();
    await expect(
      pane.getByLabel("Active tools").getByText(`$ ${command}`, {
        exact: true,
      }),
    ).toBeVisible();
    await summary.click();
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: "Read notes.md (files.read)",
        exact: true,
      }),
    ).toBeVisible();
    const running = pane.getByRole("button", {
      name: `${command} (bash.run)`,
      exact: true,
    });
    await expect(running).toBeVisible();
    await expect(pane.getByText(`$ ${command}`, { exact: true })).toHaveCount(
      1,
    );
    await running.click();
    await expect(
      pane
        .getByRole("region", { name: "bash.run", exact: true })
        .getByRole("code"),
    ).toHaveText(js);

    request.respond("The report is ready.");
    await llm.respond(m.assistant("Finished the report."));
    await expect(
      pane.getByText("Finished the report.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await app.quit();
    await app.open();

    const restored = app.page.getByRole("main");
    await expect(
      restored.getByRole("button", {
        name: "Ran 1 command and read 1 file",
        exact: true,
      }),
    ).toBeVisible();
    await expect(restored.getByLabel("Active tools")).toHaveCount(0);
    await restored
      .getByRole("button", {
        name: "Ran 1 command and read 1 file",
        exact: true,
      })
      .click();
    await expect(
      restored.getByRole("button", {
        name: "Read notes.md (files.read)",
        exact: true,
      }),
    ).toBeVisible();
    await restored
      .getByRole("button", { name: `${command} (bash.run)`, exact: true })
      .click();
    await expect(
      restored.getByRole("region", { name: "bash.run", exact: true }),
    ).toContainText("The report is ready.");
  },
);

e2eTest(
  "keeps tool details expanded through exec progress and assistant streaming",
  async ({ app, llm, http }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports and summarize them");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    const js = `await tools.bash.run({ command: ${JSON.stringify(firstCommand)}, timeoutMs: 60000 }); return await tools.bash.run({ command: ${JSON.stringify(secondCommand)}, timeoutMs: 60000 });`;
    await llm.respond(
      m.tool.start("exec", { id: "reports", arguments: { js } }),
    );
    const first = await http.request("/first");
    const pane = app.page.getByRole("main");
    await pane.getByRole("button", { name: "Working", exact: true }).click();
    const call = pane.getByRole("button", {
      name: `${firstCommand} (bash.run)`,
      exact: true,
    });
    await call.click();
    const details = pane.getByRole("region", {
      name: "bash.run",
      exact: true,
    });
    await expect(details.getByRole("code")).toHaveText(js);

    first.respond("First report");
    const second = await http.request("/second");
    await expect(
      pane.getByRole("button", {
        name: `${secondCommand} (bash.run)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();

    second.respond("Second report");
    const verificationCommand = `curl --silent --fail '${http.url("/verify")}'`;
    await llm.respond(
      m.tool.start("bash", {
        id: "verification",
        arguments: { command: verificationCommand, timeoutMs: 60_000 },
      }),
    );
    const verification = await http.request("/verify");
    await expect(
      pane.getByRole("button", {
        name: `${verificationCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toContainText("Second report");

    verification.respond("Verified");
    const response = await llm.stream();
    response.write(m.assistant("Both reports"));
    await expect(pane.getByText("Both reports", { exact: true })).toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();

    response.write(m.assistant(" are ready."));
    response.end();
    await expect(
      pane.getByText("Both reports are ready.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
    await expect(call).toHaveAttribute("aria-expanded", "true");
    await expect(details).toContainText("Second report");
  },
);

const expansionScenarios: {
  name: string;
  path: string;
  nested: boolean;
  args: Record<string, string>;
  active: string;
  completed: string;
  aggregate: string;
  result: string;
}[] = [
  {
    name: "nested integration",
    path: "google_calendar.events.list",
    nested: true,
    args: { calendarId: "primary" },
    active: "Using Google Calendar",
    completed: "Used Google Calendar",
    aggregate: "Used Google Calendar",
    result: "Team planning at 10 AM",
  },
  {
    name: "tool discovery",
    path: "search",
    nested: true,
    args: { query: "calendar" },
    active: "Searching tools",
    completed: "Searched tools",
    aggregate: "Searched tools",
    result: "Found google_calendar.events.list",
  },
  {
    name: "direct file",
    path: "read",
    nested: false,
    args: { path: "notes.md" },
    active: "Reading notes.md",
    completed: "Read notes.md",
    aggregate: "Read 1 file",
    result: "Project notes from the workspace",
  },
];

for (const scenario of expansionScenarios) {
  e2eTest(
    `expands saved ${scenario.name} tool details after reload`,
    async ({ harness, app }) => {
      const js = `return await tools.${scenario.path}(${JSON.stringify(scenario.args)});`;
      await harness.loadSession({
        title: "Expandable tools",
        messages: [
          m.user("Show the result"),
          scenario.nested
            ? m.exec({
                js,
                tools: [{ path: scenario.path, arguments: scenario.args }],
                result: scenario.result,
              })
            : {
                type: "tool",
                name: scenario.path,
                arguments: scenario.args,
                result: scenario.result,
              },
        ],
      });
      const pane = app.page.getByRole("main", { name: "Expandable tools" });
      await app.page.reload();
      await pane
        .getByRole("button", { name: scenario.aggregate, exact: true })
        .click();
      const call = pane.getByRole("button", {
        name: `${scenario.completed} (${scenario.path})`,
        exact: true,
      });
      await expect(call).toHaveAttribute("aria-expanded", "false");
      await call.click();
      const details = pane.getByRole("region", {
        name: scenario.path,
        exact: true,
      });
      if (scenario.nested) {
        await expect(details.getByRole("code").first()).toHaveText(js);
      } else {
        await expect(
          details.getByRole("grid", { name: "Tool arguments" }),
        ).toBeVisible();
        for (const [name, value] of Object.entries(scenario.args)) {
          await expect(
            details.getByRole("rowheader", { name, exact: true }),
          ).toBeVisible();
          await expect(details.getByText(value, { exact: true })).toBeVisible();
        }
      }
      await expect(
        details.getByText(scenario.result, { exact: true }),
      ).toBeVisible();
      await call.click();
      await expect(details).toBeHidden();
    },
  );
}

e2eTest(
  "keeps parallel tool activity visible when another tool finishes",
  async ({ app, llm, http }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    await llm.respond([
      m.tool.start("bash", {
        id: "first",
        arguments: { command: firstCommand, timeoutMs: 60_000 },
      }),
      m.tool.start("bash", {
        id: "second",
        arguments: { command: secondCommand, timeoutMs: 60_000 },
      }),
    ]);
    const [first, second] = await Promise.all([
      http.request("/first"),
      http.request("/second"),
    ]);
    const pane = app.page.getByRole("main");
    const activeTools = pane.getByLabel("Active tools");
    await expect(
      activeTools.getByText(`$ ${firstCommand}`, { exact: true }),
    ).toBeVisible();
    await expect(
      activeTools.getByText(`$ ${secondCommand}`, { exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Working", exact: true }).click();
    await expect(activeTools).toHaveCount(0);
    first.respond("First report");
    await pane
      .getByRole("button", { name: `${firstCommand} (bash)`, exact: true })
      .click();
    await expect(
      pane.getByRole("region", { name: "bash", exact: true }),
    ).toContainText("First report");
    const liveAggregate = pane.getByRole("button", {
      name: "Ran 1 command",
      exact: true,
    });
    await expect(liveAggregate).toBeVisible();
    await expectThinkingVisible(
      liveAggregate.getByRole("status", { name: "Working" }),
    );
    await liveAggregate.hover();
    await expect(
      liveAggregate.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
    await expect(
      pane.getByRole("button", {
        name: `${firstCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", {
        name: `${secondCommand} (bash)`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane.getByText(`$ ${secondCommand}`, { exact: true }),
    ).toHaveCount(1);
    second.respond("Second report");
    await llm.respond(m.assistant("Both reports are ready."));
    const settled = pane.getByRole("button", {
      name: "Ran 2 commands",
      exact: true,
    });
    await expect(settled).toBeVisible();
    await expect(
      settled.getByRole("img", { name: "Expand tool activity" }),
    ).toBeVisible();
    await expect(settled.getByRole("status", { name: "Working" })).toHaveCount(
      0,
    );
    await expect(pane.getByLabel("Active tools")).toHaveCount(0);
  },
);

e2eTest(
  "shows identical parallel commands as separate active work",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Run the same command twice");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const command = "sleep 5; echo done";
    await llm.respond([
      m.tool.start("bash", {
        id: "first",
        arguments: { command },
      }),
      m.tool.start("bash", {
        id: "second",
        arguments: { command },
      }),
    ]);

    await expect(
      app.page
        .getByLabel("Active tools")
        .getByText(`$ ${command}`, { exact: true }),
    ).toHaveCount(2);

    await llm.respond(m.assistant("Both commands finished."));
    await expect(
      app.page.getByText("Both commands finished.", { exact: true }),
    ).toBeVisible();
  },
);

e2eTest(
  "shows a generic label for unlabeled exec work",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Generic tool work",
      messages: [
        m.user("Do the work"),
        m.exec({ js: "return 'done'", result: "Done" }),
      ],
    });

    const summary = app.page.getByRole("button", {
      name: "Used tools",
      exact: true,
    });
    await summary.click();
    await app.page
      .getByRole("button", { name: "Used tools (exec)", exact: true })
      .click();
    const details = app.page.getByRole("region", {
      name: "exec",
      exact: true,
    });
    await expect(details.getByRole("code").first()).toHaveText("return 'done'");
    await expect(details.getByText("Done", { exact: true })).toBeVisible();
  },
);

async function expectThinkingVisible(indicator: Locator) {
  await expect(indicator).toBeVisible();
  // The status container can be visible even when its animated dots have no painted area.
  await expect
    .poll(
      async () =>
        await indicator.evaluate((element) =>
          Array.from(element.children).some((dot) => {
            const bounds = dot.getBoundingClientRect();
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              Number(getComputedStyle(dot).opacity) > 0
            );
          }),
        ),
    )
    .toBe(true);
}

e2eTest(
  "deduplicates completed file activity by normalized path",
  async ({ harness, app }) => {
    await harness.loadSession({
      title: "Read project files",
      messages: [
        m.user("Read the project files"),
        m.read({ path: "./notes.md", result: "Notes" }),
        m.read({
          path: `${harness.paths.workspace}/notes.md`,
          result: "Notes again",
        }),
        m.read({ path: "README.md", result: "Readme" }),
      ],
    });

    await expect(
      app.page.getByRole("button", {
        name: "Read 2 files",
        exact: true,
      }),
    ).toBeVisible();
  },
);

e2eTest(
  "restores partial assistant text on reload and continues the same response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Explain the plan");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    response.write(m.assistant("The first step"));
    await expect(
      app.page.getByRole("log", { name: "Session transcript" }),
    ).toContainText("The first step");

    await app.page.reload();

    const transcript = app.page.getByRole("log", {
      name: "Session transcript",
    });
    await expect(transcript).toContainText("The first step");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    response.write(m.assistant(" is to save the notes."));
    response.end();
    await expect(
      transcript.getByText("The first step is to save the notes.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
  },
);

e2eTest(
  "shows running sessions and keeps completed results unread until opened",
  async ({ app, llm }) => {
    const listRequests: string[] = [];
    await app.page.route("**/rpc/sessions/list", async (route) => {
      listRequests.push(route.request().url());
      await route.abort();
    });
    // An interrupted transport must reconnect automatically before showing the list.
    let summaryConnections = 0;
    await app.page.route("**/rpc/server/watch", async (route) => {
      summaryConnections++;
      if (summaryConnections === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "",
        });
        return;
      }
      await route.continue();
    });
    await app.page.reload();

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Prepare my report");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const row = app.page.getByRole("row").filter({
      has: app.page.getByRole("link", {
        name: "Prepare my report",
        exact: true,
      }),
    });
    const working = row.getByRole("img", { name: "Agent is working" });
    const unread = row.getByRole("img", { name: "Unread result" });
    await expect(working).toBeVisible();
    await expect(unread).not.toBeVisible();

    // Opening a running session must not count its future result as read.
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await row.getByRole("link").click();
    await expect(working).toBeVisible();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const response = await llm.stream();
    response.write(m.assistant("The report is ready."));
    await expect(working).toBeVisible();
    response.end();
    await expect(unread).toBeVisible();
    await expect(working).not.toBeVisible();

    await app.page.reload();
    await expect(unread).toBeVisible();
    await row.getByRole("link").click();
    await expect(app.page.getByRole("log")).toContainText(
      "The report is ready.",
    );
    await expect(unread).not.toBeVisible();
    await app.page.reload();
    await expect(row).toBeVisible();
    await expect(unread).not.toBeVisible();

    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Add a conclusion");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(working).toBeVisible();
    await llm.respond(m.assistant("Here is the conclusion."));
    await expect(working).not.toBeVisible();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page.reload();
    await expect(row).toBeVisible();
    await expect(unread).not.toBeVisible();
    expect(summaryConnections).toBeGreaterThanOrEqual(2);
    expect(listRequests).toEqual([]);
  },
);

e2eTest(
  "shares unread results and read receipts between windows",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Work while I am away");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.page.getByRole("img", { name: "Agent is working" }),
    ).toBeVisible();
    const otherWindow = await app.openWindow();
    await otherWindow.getByRole("main").waitFor();
    await otherWindow
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await llm.respond(m.assistant("Your result arrived while you were away."));
    const unread = app.page.getByRole("img", { name: "Unread result" });
    await expect(unread).toBeVisible();
    await expect(
      otherWindow.getByRole("img", { name: "Unread result" }),
    ).toBeVisible();
    await app.page
      .getByRole("link", { name: "Work while I am away", exact: true })
      .click();
    await expect(unread).not.toBeVisible();
    await expect(
      otherWindow.getByRole("img", { name: "Unread result" }),
    ).not.toBeVisible();
    await otherWindow.close();
  },
);

e2eTest(
  "Tiptap submits edited source fragments from the composer",
  async ({ app, llm }) => {
    const editor = app.page
      .getByRole("main", { name: "New session" })
      .getByLabel("Message", { exact: true });
    await editor.fill("");
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        "<p>Send <strong>this</strong> and <em>that</em>.</p>",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await editor.locator("strong").click();
    const source = editor.getByRole("textbox", { name: "Markdown syntax" });
    await expect(source).toHaveText("**this**");
    await source.fill("*changed*");
    await source.press("ControlOrMeta+Enter");
    await llm.respond(({ messages }) => {
      expect(messageText(messages.at(-1)!)).toContain(
        "Send *changed* and *that*.",
      );
      return m.assistant("Received the edited formatting.");
    });
    await expect(
      app.page.getByRole("log", { name: "Session transcript" }),
    ).toContainText("Received the edited formatting.");
  },
);
