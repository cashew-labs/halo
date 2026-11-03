#!/usr/bin/env node
// Prompt lab: revise a system prompt against real model replies.
// Uses only Node built-ins. Run `node prompt-lab.mjs --help` for usage.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = `Usage: node prompt-lab.mjs <command> <lab-directory> [options]

Commands:
  init <dir> <prompt-file>   Create a lab from the current system prompt
  run <dir>                  Generate one reply per example with candidate.md
  status <dir>               Show the reviewer's verdicts for the latest round
  serve <dir> [--port 4310]  Serve the review page`;

const defaultConfig = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKeyEnv: "OPENAI_API_KEY",
  request: { max_tokens: 8192 },
  userNote:
    "This conversation is text-only. You have no tools, files, or connected services. When the answer depends on information you do not have, say what you need.",
};

function files(directory) {
  return {
    config: path.join(directory, "lab.json"),
    baseline: path.join(directory, "baseline.md"),
    candidate: path.join(directory, "candidate.md"),
    examples: path.join(directory, "examples.json"),
    notes: path.join(directory, "NOTES.md"),
    rounds: path.join(directory, "rounds.jsonl"),
    reviews: path.join(directory, "reviews.jsonl"),
  };
}

async function readText(file) {
  return await fs
    .readFile(file, "utf8")
    .catch((cause) => new Error(`Could not read ${file}.`, { cause }));
}

async function readJson(file) {
  const text = await readText(file);
  if (text instanceof Error) return text;
  try {
    return JSON.parse(text);
  } catch (cause) {
    return new Error(`${file} is not valid JSON.`, { cause });
  }
}

async function readJsonLines(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  try {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch (cause) {
    return new Error(`${file} has a line that is not valid JSON.`, { cause });
  }
}

async function appendJsonLine(file, value) {
  return await fs
    .appendFile(file, `${JSON.stringify(value)}\n`)
    .catch((cause) => new Error(`Could not write ${file}.`, { cause }));
}

async function init(directory, promptFile) {
  if (promptFile === undefined)
    return new Error("Pass the file that holds the current system prompt.");
  const prompt = await readText(promptFile);
  if (prompt instanceof Error) return prompt;
  const paths = files(directory);
  const made = await fs
    .mkdir(directory, { recursive: true })
    .catch((cause) => new Error(`Could not create ${directory}.`, { cause }));
  if (made instanceof Error) return made;
  const contents = [
    [paths.config, `${JSON.stringify(defaultConfig, undefined, 2)}\n`],
    [paths.baseline, prompt],
    [paths.candidate, prompt],
    [paths.examples, "[]\n"],
    [paths.notes, "# Review notes\n"],
  ];
  for (const [file, content] of contents) {
    const written = await fs.writeFile(file, content, { flag: "wx" }).catch(
      (cause) =>
        new Error(`${file} already exists. Choose a new lab directory.`, {
          cause,
        }),
    );
    if (written instanceof Error) return written;
  }
  return `Created ${directory}. Set the model in lab.json and add user messages to examples.json.`;
}

async function generateReply(config, systemPrompt, message) {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey)
    return new Error(`Set ${config.apiKeyEnv} to the model's API key.`);
  const content = config.userNote
    ? `${config.userNote}\n\nUser message:\n${message}`
    : message;
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...config.request,
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
      }),
    },
  ).catch(
    (cause) => new Error(`Could not reach ${config.baseUrl}.`, { cause }),
  );
  if (response instanceof Error) return response;
  const body = await response.json().catch(() => undefined);
  if (!response.ok)
    return new Error(
      `The model API answered ${response.status}: ${body?.error?.message ?? "no details"}`,
    );
  const choice = body?.choices?.[0];
  const reply = choice?.message?.content?.trim();
  if (!reply) return new Error("The model returned an empty reply.");
  if (choice.finish_reason === "length")
    return new Error(
      "The reply hit the token limit. Raise request.max_tokens.",
    );
  return {
    reply,
    inputTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
  };
}

async function run(directory) {
  const paths = files(directory);
  const config = await readJson(paths.config);
  if (config instanceof Error) return config;
  const examples = await readJson(paths.examples);
  if (examples instanceof Error) return examples;
  if (
    !Array.isArray(examples) ||
    examples.length === 0 ||
    !examples.every((example) => typeof example === "string" && example.trim())
  )
    return new Error(`${paths.examples} must list user messages as strings.`);
  const prompt = await readText(paths.candidate);
  if (prompt instanceof Error) return prompt;
  const replies = await Promise.all(
    examples.map(
      async (message) => await generateReply(config, prompt, message),
    ),
  );
  const failed = replies.find((reply) => reply instanceof Error);
  if (failed !== undefined) return failed;
  const round = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    model: config.model,
    prompt,
    runs: replies.map((reply, index) => ({
      id: randomUUID(),
      message: examples[index],
      ...reply,
    })),
  };
  const saved = await appendJsonLine(paths.rounds, round);
  if (saved instanceof Error) return saved;
  const lines = round.runs.map(
    (item, index) =>
      `${index + 1}. ${item.reply.split(/\s+/).length} words, ${item.inputTokens ?? "?"} input tokens: ${item.message.split("\n")[0].slice(0, 70)}`,
  );
  return `Saved a round of ${round.runs.length} replies.\n${lines.join("\n")}`;
}

async function readState(directory) {
  const paths = files(directory);
  const rounds = await readJsonLines(paths.rounds);
  if (rounds instanceof Error) return rounds;
  const reviews = await readJsonLines(paths.reviews);
  if (reviews instanceof Error) return reviews;
  const baseline = await readText(paths.baseline);
  if (baseline instanceof Error) return baseline;
  // The last verdict for a reply wins, so the reviewer can change their mind.
  const verdicts = new Map(
    reviews.map((review) => [review.runId, review.verdict]),
  );
  const latest = rounds.at(-1);
  return {
    name: path.basename(directory),
    round: latest && {
      id: latest.id,
      number: rounds.length,
      baseline,
      prompt: latest.prompt,
      runs: latest.runs.map((item) => ({
        id: item.id,
        message: item.message,
        reply: item.reply,
        verdict: verdicts.get(item.id),
      })),
    },
  };
}

async function status(directory) {
  const state = await readState(directory);
  if (state instanceof Error) return state;
  if (state.round === undefined) return "No rounds yet.";
  const lines = state.round.runs.map(
    (item, index) =>
      `${index + 1}. ${item.verdict ?? "unreviewed"}: ${item.message.split("\n")[0].slice(0, 70)}`,
  );
  return `Round ${state.round.number}\n${lines.join("\n")}`;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) return undefined;
  }
  return body;
}

function send(response, status, body, type = "application/json") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(directory, page, request, response) {
  // The page and API share an origin; refuse requests that other sites start.
  if (request.headers["sec-fetch-site"] === "cross-site")
    return send(response, 403, { error: "Cross-site requests are refused." });
  if (request.method === "GET" && request.url === "/")
    return send(response, 200, page, "text/html; charset=utf-8");
  if (request.method === "GET" && request.url === "/api/state") {
    const state = await readState(directory);
    if (state instanceof Error)
      return send(response, 500, { error: state.message });
    return send(response, 200, state);
  }
  if (request.method === "POST" && request.url === "/api/review") {
    let review;
    try {
      review = JSON.parse((await readBody(request)) ?? "");
    } catch {
      return send(response, 400, { error: "Send JSON { runId, verdict }." });
    }
    const state = await readState(directory);
    if (state instanceof Error)
      return send(response, 500, { error: state.message });
    if (
      !["good", "revisit"].includes(review?.verdict) ||
      !state.round?.runs.some((item) => item.id === review.runId)
    )
      return send(response, 400, {
        error: "Review a reply from the latest round as good or revisit.",
      });
    const saved = await appendJsonLine(files(directory).reviews, {
      runId: review.runId,
      verdict: review.verdict,
      createdAt: new Date().toISOString(),
    });
    if (saved instanceof Error)
      return send(response, 500, { error: saved.message });
    return send(response, 200, {});
  }
  send(response, 404, { error: "Not found." });
}

async function serve(directory, port) {
  const state = await readState(directory);
  if (state instanceof Error) return state;
  const page = await readText(new URL("../assets/lab.html", import.meta.url));
  if (page instanceof Error) return page;
  const server = http.createServer((request, response) => {
    handle(directory, page, request, response).catch(() =>
      send(response, 500, { error: "The request failed." }),
    );
  });
  const listening = await new Promise((resolve) => {
    server.once("error", (cause) =>
      resolve(new Error(`Could not listen on port ${port}.`, { cause })),
    );
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  if (listening instanceof Error) return listening;
  console.log(`Prompt lab for ${directory} at http://127.0.0.1:${port}`);
  return await new Promise(() => {});
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4310" },
      help: { type: "boolean" },
    },
  });
  const [command, directory, ...rest] = positionals;
  if (values.help || command === undefined) return usage;
  if (directory === undefined) return new Error(usage);
  const lab = path.resolve(directory);
  if (command === "init") return await init(lab, rest[0]);
  if (command === "run") return await run(lab);
  if (command === "status") return await status(lab);
  if (command === "serve") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return new Error("Choose a port from 1024 to 65535.");
    return await serve(lab, port);
  }
  return new Error(usage);
}

const result = await main();
if (result instanceof Error) {
  console.error(result.message);
  process.exitCode = 1;
} else if (result !== undefined) console.log(result);
