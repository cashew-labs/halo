import { expect, type Locator } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";

e2eTest("starts a new session", async ({ harness, app }) => {
  await harness.loadSession({
    title: "Existing conversation",
    messages: [
      m.user("Summarize this workspace"),
      m.assistant("Here is the summary."),
    ],
  });

  await app.page.getByRole("button", { name: "New session" }).click();

  const newSession = app.page.getByRole("main", { name: "New session" });
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

    await app.page.getByRole("button", { name: "New session" }).click();
    const draft = app.page.getByRole("main", { name: "New session" });
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
      .getByLabel("Message", { exact: true })
      .fill("Start a long answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();

    await app.page.getByRole("button", { name: "Stop", exact: true }).click();
    await app.page
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
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
    await app.page.getByRole("button", { name: "New session" }).click();
    const pane = app.page.getByRole("main");
    const observed = await app.page.evaluateHandle(() => {
      const titles: string[] = [];
      const observer = new MutationObserver(() => {
        const title = document
          .querySelector("main > header")
          ?.getAttribute("aria-label");
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
    await expect(app.page.locator("main > header")).toHaveText(
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
    await expect(app.page.locator("main > header")).toHaveText(
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
  await expect(card.getByRole("button", { name: "Connect" })).toBeVisible();
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
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(
      card.getByRole("button", { name: "Connecting" }),
    ).toBeVisible();
    await expect(
      card.getByText("Finish connecting in your browser"),
    ).toBeVisible();
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(card.getByText("Authorization cancelled")).toBeVisible();
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
      .getByLabel("Message", { exact: true })
      .fill("Read the notes and fetch the report");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const command = `curl --silent --fail '${http.url("/report")}'`;
    const js = `await tools.files.read({ path: "notes.md" }); return await tools.bash.run({ command: ${JSON.stringify(command)} });`;
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
      name: "Running command",
      exact: true,
    });
    await expect(summary).toBeVisible();
    await expectThinkingVisible(
      summary.getByRole("status", { name: "Working" }),
    );
    await summary.click();
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports and summarize them");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    const js = `await tools.bash.run({ command: ${JSON.stringify(firstCommand)} }); return await tools.bash.run({ command: ${JSON.stringify(secondCommand)} });`;
    await llm.respond(
      m.tool.start("exec", { id: "reports", arguments: { js } }),
    );
    const first = await http.request("/first");
    const pane = app.page.getByRole("main");
    await pane
      .getByRole("button", { name: "Running command", exact: true })
      .click();
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
        arguments: { command: verificationCommand },
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
      .getByLabel("Message", { exact: true })
      .fill("Fetch both reports");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const firstCommand = `curl --silent --fail '${http.url("/first")}'`;
    const secondCommand = `curl --silent --fail '${http.url("/second")}'`;
    await llm.respond([
      m.tool.start("bash", {
        id: "first",
        arguments: { command: firstCommand },
      }),
      m.tool.start("bash", {
        id: "second",
        arguments: { command: secondCommand },
      }),
    ]);
    const [first, second] = await Promise.all([
      http.request("/first"),
      http.request("/second"),
    ]);
    const pane = app.page.getByRole("main");
    await pane
      .getByRole("button", { name: "Running command", exact: true })
      .click();
    first.respond("First report");
    await pane
      .getByRole("button", { name: `${firstCommand} (bash)`, exact: true })
      .click();
    await expect(
      pane.getByRole("region", { name: "bash", exact: true }),
    ).toContainText("First report");
    await expect(
      pane.getByRole("button", { name: "Running command", exact: true }),
    ).toBeVisible();
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
    second.respond("Second report");
    await llm.respond(m.assistant("Both reports are ready."));
    await expect(
      pane.getByRole("button", { name: "Ran 2 commands", exact: true }),
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
    await app.page.getByRole("button", { name: "New session" }).click();
    await app.page
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
