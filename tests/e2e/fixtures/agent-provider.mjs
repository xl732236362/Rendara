import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = 3199;
const fixtureBaseUrl = `http://${host}:${port}/v1`;
const transparentPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const root = fileURLToPath(new URL("../../..", import.meta.url));
let workerExit = null;

const worker = spawn(process.execPath, ["--import", "tsx", "./src/worker.ts"], {
  cwd: `${root}/apps/server`,
  env: {
    ...process.env,
    OPENAI_API_KEY: "e2e-fixture-key",
    OPENAI_API_BASE: fixtureBaseUrl,
    OPENAI_BASE_URL: fixtureBaseUrl,
    WORKER_ID: "e2e-fixture-worker",
  },
  stdio: "inherit",
});

worker.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error("[e2e.fixture] worker exited unexpectedly", { code, signal });
    workerExit = { code, signal };
  }
});

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, workerExit ? 503 : 200, {
        ok: workerExit === null,
        worker: workerExit ? "exited" : "running",
      });
    }
    if (request.method !== "POST") {
      return sendJson(response, 404, { error: { message: "not_found" } });
    }

    const body = await readJson(request);
    if (request.url === "/v1/images/generations") {
      return sendJson(response, 200, {
        created: 1,
        data: [{ b64_json: transparentPng }],
      });
    }
    if (request.url === "/v1/chat/completions") {
      return sendChatCompletion(response, body);
    }
    return sendJson(response, 404, { error: { message: "not_found" } });
  } catch (error) {
    console.error("[e2e.fixture] request failed", {
      code: error instanceof SyntaxError ? "invalid_json" : "fixture_error",
    });
    return sendJson(response, 500, { error: { message: "fixture_error" } });
  }
});

let shuttingDown = false;
server.listen(port, host, () => {
  console.log(`[e2e.fixture] ready on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

function sendChatCompletion(response, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages]
    .reverse()
    .find((message) => message?.role === "user");
  const isFollowUp = textContent(lastUser?.content).includes("Reply with done");
  const hasToolResult = messages.some((message) => message?.role === "tool");

  if (!body.stream) {
    const message =
      isFollowUp || hasToolResult
        ? { role: "assistant", content: "done" }
        : { role: "assistant", content: null, tool_calls: [toolCall()] };
    return sendJson(response, 200, {
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: 1,
      model: body.model ?? "e2e-model",
      choices: [
        {
          index: 0,
          message,
          finish_reason: hasToolResult ? "stop" : "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const model = body.model ?? "e2e-model";
  if (isFollowUp || hasToolResult) {
    writeChunk(response, model, { role: "assistant", content: "done" }, null);
    writeChunk(response, model, {}, "stop");
  } else {
    writeChunk(
      response,
      model,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, ...toolCall() }],
      },
      null,
    );
    writeChunk(response, model, {}, "tool_calls");
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function toolCall() {
  return {
    id: "call-e2e-generate-image",
    type: "function",
    function: {
      name: "generate_image",
      arguments: JSON.stringify({
        title: "Red circle",
        prompt: "A simple red circle centered on a white background",
        model: "gpt-image-2",
        aspectRatio: "1:1",
        quality: "standard",
      }),
    },
  };
}

function writeChunk(response, model, delta, finishReason) {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item?.type === "text" ? String(item.text ?? "") : ""))
    .join(" ");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.kill(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
