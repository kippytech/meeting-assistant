import { Router, type Response  } from "express";
import { z } from "zod";
import { requireSession } from "../middleware/requireSession.js";
import {
  getThreadMessages,
  listUserThreads,
  streamAgentReply,
} from "../services/agent.service.js";
import type { AgentEvent } from "../services/agent.service.js";

export const agentRoutes = Router();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(5000),
  threadId: z.uuid(),
});

const threadIdSchema = z.uuid();

agentRoutes.use(requireSession);

agentRoutes.get("/threads", async (req, res) => {
  try {
    const threads = await listUserThreads(req.authContext!.authUserId);
    res.json({ threads });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to list threads";
    res.status(500).json({ error: message });
  }
});

agentRoutes.get("/threads/:threadId", async (req, res) => {
  const parsed = threadIdSchema.safeParse(req.params.threadId);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid threadId" });
    return;
  }
  try {
    const messages = await getThreadMessages(req.authContext!.authUserId, parsed.data);
    res.json({ threadId: parsed.data, messages });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to list threads";
    res.status(500).json({ error: message });
  }
});


class ClientDisconnectedError extends Error {
  constructor() {
    super("SSE client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

async function writeSse(res: Response, event: AgentEvent): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    throw new ClientDisconnectedError();
  }

  const accepted = res.write(
    `data: ${JSON.stringify(event)}\n\n`,
  );

  if (accepted) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);

    // The buffer may have drained between write() and listener setup.
    if (res.destroyed || res.writableEnded) {
      onClose();
    } else if (!res.writableNeedDrain) {
      onDrain();
    }
  });
}

agentRoutes.post("/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid chat body" });
    return;
  }

  const controller = new AbortController();

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  //res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.once("close", () => {
    if (!res.writableEnded) {
      controller.abort(new Error("Client disconnected"));
    }
  });

  // const write = async (event: Record<string, unknown>) => {
  //   res.write(`data: ${JSON.stringify(event)}\n\n`);
  // };

  try {
    await streamAgentReply({
      userId: req.authContext!.userId,
      authUserId: req.authContext!.authUserId,
      threadId: parsed.data.threadId,
      message: parsed.data.message,
      //onEvent: write,
      signal: controller.signal,
      onEvent: (event) => writeSse(res, event),
    });
  } catch (error) {
    if (
      controller.signal.aborted ||
      res.destroyed ||
      error instanceof ClientDisconnectedError
    ) {
      console.info("[agent] Client disconnected; stream cancelled");
      return;
    }

    console.error("[agent route] execution failed:", error);

    if (!res.destroyed && !res.writableEnded) {
      const message =
        error instanceof Error ? error.message : "Unknown agent error";

      await writeSse(res, {
        type: "error",
        message:
          process.env.NODE_ENV === "production"
            ? "Agent execution failed"
            : message,
      }).catch(() => {});
    }
  }

    // Log the detailed error server-side, with a request/correlation ID.
  finally {
    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
});
