import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMeetingPrompts(server: McpServer) {
  server.registerPrompt("prepare_meeting_agenda", {
    title: "Prepare a meeting agenda",
    description: "Create a focused agenda and preparation checklist for a meeting.",
    argsSchema: {
      title: z.string().min(1).max(200),
      purpose: z.string().max(2000).optional(),
      attendees: z.string().max(2000).optional(),
      durationMinutes: z.string().optional(),
      context: z.string().max(5000).optional(),
    },
  }, ({ title, purpose, attendees, durationMinutes, context }) => ({
    description: `Agenda preparation for ${title}`,
    messages: [{ role: "user", content: { type: "text", text: [
      `Prepare a practical agenda for: ${title}.`,
      purpose ? `Purpose: ${purpose}` : "Ask what outcome the meeting should achieve if unclear.",
      attendees ? `Attendees: ${attendees}` : "",
      durationMinutes ? `Duration: ${durationMinutes} minutes` : "",
      context ? `Context: ${context}` : "",
      "Provide timed agenda items, desired decisions, pre-reading or preparation, and open questions. Keep the agenda proportionate to the meeting length and do not invent facts.",
    ].filter(Boolean).join("\n\n") } }],
  }));
}
