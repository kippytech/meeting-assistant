import { Agent } from "@mastra/core/agent";
import { createAgentMemory } from "../config/memory.js";
import { getAgentInstructions } from "../config/agent-instructions.js";
import { createCalendarTools } from "./agent-tools.service.js";

export type AgentEvent = {
  type: "started" | "progress" | "token" | "completed" | "error";
  message?: string;
  token?: string;
};

export type StreamAgentReplyInput = {
  userId: string;
  authUserId: string;
  threadId: string;
  message: string;
  onEvent: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
};

export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

function modelName() {
  // Mastra model identifiers use the provider/model form, for example
  // "google/gemini-3.8-flash" or "openai/gpt-4o-mini".
  return process.env.AI_MODEL ?? "google/gemini-3.8-flash";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";

  const record = content as {
    content?: unknown;
    parts?: Array<{ type?: string; text?: string }>;
  };

  if (typeof record.content === "string" && record.content.trim()) {
    return record.content.trim();
  }

  if (!Array.isArray(record.parts)) return "";
  return record.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function listUserThreads(
  authUserId: string,
): Promise<ThreadSummary[]> {
  const memory = createAgentMemory();

  const result = await memory.listThreads({
    filter: { resourceId: authUserId },
    perPage: 30,
    orderBy: { field: "updatedAt", direction: "DESC" },
  });

  return result.threads.map((thread) => ({
    id: thread.id,
    title: thread.title?.trim() || "Untitled Chat",
    updatedAt:
      thread.updatedAt instanceof Date
        ? thread.updatedAt.toISOString()
        : String(thread.updatedAt),
  }));
}

export async function getThreadMessages(
  authUserId: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const memory = createAgentMemory();

  const thread = await memory.getThreadById({
    threadId,
    resourceId: authUserId,
  });

  if (!thread || thread.resourceId !== authUserId) {
    throw new Error("Thread not found");
  }

  const recalledMemoryData = await memory.recall({
    threadId,
    resourceId: authUserId,
    perPage: false, //prefer cursor-based pagination over this
  });

  const messages: ThreadMessage[] = [];

  for (const message of recalledMemoryData.messages) {
    const content = messageText(message.content);

    if (!content) {
      continue;
    }

    const role: ThreadMessage["role"] =
      message.role === "user" || message.role === "assistant"
        ? message.role
        : "system";

    // if (
    //   message.role !== "user" &&
    //   message.role !== "assistant"
    // ) {
    //   continue;
    // }

    messages.push({
      id: message.id,
      role,
      content,
    });
  }

  return messages;
}

export async function streamAgentReply(input: StreamAgentReplyInput) {
  input.onEvent({
    type: "started",
    message: "Agent is planning",
  });

  const memory = createAgentMemory();

  const agent = new Agent({
    id: "meeting-assistant",
    name: "Meeting Assitant",
    instructions: getAgentInstructions(),
    model: modelName(),
    tools: createCalendarTools(input.authUserId),
    memory,
  });

  console.log("[agent] agent constructed");

  const result = await agent.stream(input.message, {
    memory: {
      resource: input.authUserId,
      thread: input.threadId,
    },
    abortSignal: input.signal,
  });

  let streamError: unknown;

  console.log("[agent] stream initialized");

  for await (const chunk of result.fullStream) {
    console.dir(chunk, { depth: 5 });

    switch (chunk.type) {
      case "tool-call":
        // if (chunk.payload.toolName === "updateWorkingMemory" || chunk.payload.toolName === "setWorkingMemory") {
        //   await input.onEvent({
        //     type: "progress",
        //     message: `Updating working memory`,
        //   });
        // }

        // if (chunk.payload.toolName === "getConversationHistory") {
        //   await input.onEvent({
        //     type: "progress",
        //     message: `Retrieving conversation history`,
        //   });
        // }

        await input.onEvent({
          type: "progress",
          message: `Running ${chunk.payload.toolName}`,
        });
        break;

      case "tool-result":
        console.log("Tool result:", chunk.payload);
        break;

      case "tool-error":
        console.error("Tool execution error:", chunk.payload);
        break;

      case "text-delta":
        if (chunk.payload.text) {
          await input.onEvent({
            type: "token",
            token: chunk.payload.text,
          });
        }
        break;

      case "error":
        console.error("Mastra stream error:", chunk.payload.error);
        streamError = chunk.payload.error;
        break;

      case "finish":
        console.log("Finish reason:", chunk.payload.stepResult.reason);
        console.log("Raw finish reason:", chunk.payload.stepResult.rawReason);
        break;

      default:
        console.log("Other stream event:", chunk.type);
    }
  }

  // console.log("Stream error:", result.error);
  // if (result.error) {
  //   throw result.error;
  // }

  console.log("[agent] stream consumption finished");

  const output = await result.getFullOutput();

  console.log("Final output:", {
    text: output.text,
    finishReason: output.finishReason,
    usage: output.usage,
    toolCalls: output.toolCalls,
    toolResults: output.toolResults,
  });

  const failure = streamError ?? result.error ?? output.error;

  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error(
          typeof failure === "string"
            ? failure
            : "Agent execution failed",
        );
  }

  // streaming finishes  
  const thread = await memory.getThreadById({
    threadId: input.threadId,
    resourceId: input.authUserId,
  });

  if (thread && !thread.title?.trim()) {
    await memory.updateThread({
      id: thread.id,
      title: input.message.slice(0, 80),
      metadata: thread.metadata ?? {},
    });
  }

  await input.onEvent({
    type: "completed",
    message: "done",
  });
}
