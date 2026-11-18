import { apiFetch } from "@/lib/api";
import { createParser } from "eventsource-parser";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type AgentStreamEvent = {
  type: "started" | "progress" | "token" | "completed" | "error";
  message?: string;
  token?: string;
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

export async function listThreads(token: string) {
  return apiFetch<{ threads: ThreadSummary[] }>("/api/agent/threads", {
    token,
  });
}

export async function loadThread(token: string, threadId: string) {
  return apiFetch<{ threadId: string; messages: ThreadMessage[] }>(
    `/api/agent/threads/${threadId}`,
    { token },
  );
}

// export async function streamAgentChat(
//   token: string,
//   input: { message: string; threadId: string },
//   onEvent: (event: AgentStreamEvent) => void,
// ) {
//   const res = await fetch(`${API_URL}/api/agent/chat`, {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${token}`,
//       "Content-Type": "application/json",
//       Accept: "text/event-stream",
//     },
//     body: JSON.stringify(input),
//   });

//   if (!res.ok || !res.body) {
//     throw new Error("Agent request failed");
//   }

//   const reader = res.body.getReader();

//   const decoder = new TextDecoder();

//   let buffer = "";

//   while (true) {
//     const { value, done } = await reader.read();

//     buffer += decoder.decode(value, { stream: !done });

//     // sse events ->
//     const blocks = buffer.split(/\n\n/);
//     buffer = blocks.pop() ?? "";

//     for (const block of blocks) {
//       for (const line of block.split("\n")) {
//         if (!line.startsWith("data:")) continue;
//         // strip the data: prefix
//         const data = line.slice(5).trim();

//         if (data) onEvent(JSON.parse(data) as AgentStreamEvent);
//       }
//     }

//     if (done) break;
//   }
// }

export async function streamAgentChat(
  token: string,
  input: { message: string; threadId: string },
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`${API_URL}/api/agent/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();

    let message = `Agent request failed (${res.status})`;

    try {
      const parsed = JSON.parse(body) as { error?: string };
      message = parsed.error || message;
    } catch {
      if (body.trim()) message = body;
    }

    throw new Error(message);
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new Error("Expected an SSE response");
  }

  if (!res.body) {
    throw new Error("Response body is unavailable");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let parserError: Error | undefined;

  const parser = createParser({
    onEvent({ data }) {
      if (!data) return;

      try {
        onEvent(JSON.parse(data) as AgentStreamEvent);
      } catch (error) {
        parserError =
          error instanceof Error
            ? error
            : new Error("Invalid SSE event");
      }
    },

    onError(error) {
      parserError = new Error(`Invalid SSE format: ${error.message}`);
    },
  });

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      parser.feed(decoder.decode(value, { stream: true }));

      if (parserError) throw parserError;
    }

    // Flush any remaining UTF-8 decoder state.
    parser.feed(decoder.decode());

    if (parserError) throw parserError;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}