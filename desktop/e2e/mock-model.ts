import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Payload } from "../../shared/bridge.ts";

export async function startMockModel() {
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    paths.push(request.url!);
    const messages = body.messages ?? body.input;
    if (JSON.stringify(messages).includes("M3 native read")) {
      const result = messages.find((message: Payload) => message.role === "tool");
      const policy = messages.find(
        (message: Payload) =>
          typeof message.content === "string" && message.content.includes('"grants":'),
      );
      const grantId =
        policy && JSON.parse(policy.content.slice(policy.content.indexOf("{"))).grants[0].id;
      response.setHeader("content-type", "application/json");
      const tool = result
        ? {
            name: "complete_task",
            arguments: JSON.stringify({
              markdown: "# 原生读取报告\n原生读取资料\n第二行",
              evidence: ["引用原生文件与版本"],
            }),
          }
        : {
            name: "read_file",
            arguments: JSON.stringify({
              grantId,
              path: "notes.md",
              startLine: 1,
              endLine: 2,
            }),
          };
      if (result) assert.equal(JSON.parse(result.content).content, "原生读取资料\n第二行");
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: result ? "finish-report" : "read-notes",
                    type: "function",
                    function: tool,
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    if (JSON.stringify(messages).includes("background-task")) {
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "background-report",
                      type: "function",
                      function: {
                        name: "complete_task",
                        arguments: JSON.stringify({
                          markdown: "# 后台报告\n关窗后仍已完成",
                          evidence: ["报告生成并保存"],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }, 500);
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    if (
      JSON.stringify(messages).includes("crash-request") ||
      JSON.stringify(messages).includes("lifecycle-hold")
    ) {
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }
    if (JSON.stringify(messages).includes("M4 current decision"))
      assert.ok(
        messages.some(
          (message: Payload) =>
            typeof message.content === "string" &&
            message.content.includes("长期记忆") &&
            message.content.includes("SQLite"),
        ),
      );
    const events = request.url?.endsWith("/responses")
      ? [
          { type: "response.output_text.delta", delta: "你好，M1" },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "你好，M1" }],
                },
              ],
            },
          },
        ]
      : request.url?.endsWith("/messages")
        ? [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "你好，M1" },
            },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]
        : [
            { choices: [{ delta: { content: "你好，M1" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            "[DONE]",
          ];
    response.end(
      events
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join(""),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    paths,
    port: address.port,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
