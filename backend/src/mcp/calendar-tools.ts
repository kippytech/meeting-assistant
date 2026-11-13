import { defineTool, type AuthenticatedExtra } from "@descope/mcp-express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createMeeting, listUpcomingMeetings } from "../services/calendar.service.js";

const eventSchema = z.object({
  id: z.string().nullable().optional(), title: z.string(), description: z.string().nullable(), location: z.string().nullable(),
  start: z.string().nullable(), end: z.string().nullable(), htmlLink: z.string().nullable(), meetLink: z.string().nullable(), attendees: z.array(z.string()),
});
const meetingOutput = { ok: z.boolean(), meetings: z.array(eventSchema).optional(), meeting: eventSchema.extend({ inviteEmailsSent: z.boolean(), googleMeetAdded: z.boolean() }).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() };
const outputShape = meetingOutput;

function subject(extra: AuthenticatedExtra) {
  try {
    const token = extra.authInfo?.token;
    const payload = token ? JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown } : {};
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error();
    return payload.sub;
  } catch { throw Object.assign(new Error("Authentication required"), { kind: "authentication" }); }
}

function failure(error: unknown) {
  const e = error as { kind?: string; code?: number; response?: { status?: number } };
  const status = e.response?.status ?? e.code;
  if (e.kind === "authentication") return { code: "AUTHENTICATION", message: "Authentication is required." };
  if (e.kind === "validation") return { code: "VALIDATION", message: "The idempotency key was already used with different meeting details." };
  if (status === 401) return { code: "AUTHENTICATION", message: "Calendar authorization is unavailable. Reconnect Google Calendar." };
  if (status === 403) return { code: "AUTHORIZATION", message: "You are not authorized to access this calendar operation." };
  if (status === 400 || status === 422) return { code: "VALIDATION", message: "The meeting details are invalid." };
  if (typeof status === "number" && status >= 500) return { code: "EXTERNAL_API", message: "Google Calendar is temporarily unavailable." };
  return { code: "INTERNAL", message: "The calendar operation could not be completed." };
}

function result(data: Record<string, unknown>, error = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: error };
}

const defineMcpTool = defineTool as unknown as (cfg: {
  name: string; description: string; input?: z.ZodObject<any>; output?: Record<string, z.ZodType>;
  scopes?: string[]; handler: (args: any, extra: AuthenticatedExtra) => any;
}) => (server: McpServer) => unknown;

export const listUpcomingMeetingsTools = defineMcpTool({
  name: "listUpcomingMeetings", description: "List upcoming meetings from the authenticated user's Google Calendar.",
  input: z.object({ maxResults: z.number().int().min(1).max(20).optional(), todayOnly: z.boolean().optional().default(false) }),
  output: { ok: z.boolean(), meetings: z.array(eventSchema), error: z.object({ code: z.string(), message: z.string() }).optional() }, scopes: ["profile"], //calendar:read
  handler: async (args, extra) => {
    try {
      const meetings = await listUpcomingMeetings({ authUserId: subject(extra), maxResults: args.maxResults, todayOnly: args.todayOnly });
      return result({ ok: true, meetings });
    } catch (error) { return result({ ok: false, meetings: [], error: failure(error) }, true); }
  },
});

const createInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  startIso: z.string().datetime({ offset: true }).optional(), endIso: z.string().datetime({ offset: true }).optional(),
  attendeeEmails: z.array(z.string().email()).max(100).optional(), description: z.string().max(5000).optional(), addGoogleMeet: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const createMeetingTool = defineMcpTool({
  name: "createMeeting", description: "Create a Google Calendar meeting. Ask for missing title or start and end times; never invent them. Attendee invitations are sent when emails are provided.",
  input: createInput, output: outputShape, scopes: ["profile"], //calendar:write
  handler: async (args, extra) => {
    try {
      const authUserId = subject(extra);
      let data = args;
      if (!args.title || !args.startIso || !args.endIso) {
        let elicited: ElicitResult;
        try {
          elicited = await extra.sendRequest({ method: "elicitation/create", params: {
            mode: "form", message: "Please provide the meeting title and start and end times, including timezone offsets.",
            requestedSchema: { type: "object", properties: {
              title: { type: "string", title: "Meeting title", minLength: 1, maxLength: 200 },
              startIso: { type: "string", title: "Start time (ISO 8601 with offset)", format: "date-time" },
              endIso: { type: "string", title: "End time (ISO 8601 with offset)", format: "date-time" },
            }, required: ["title", "startIso", "endIso"] },
          } }, ElicitResultSchema);
        } catch {
          return result({ ok: false, error: { code: "MISSING_INFORMATION", message: "Please provide the meeting title, start time, and end time (with timezone offsets) before creating the event." } }, true);
        }
        if (elicited.action !== "accept") return result({ ok: false, error: { code: elicited.action === "decline" ? "DECLINED" : "CANCELLED", message: "Meeting creation was cancelled; no event was created." } });
        const filled = z.object({ title: z.string().trim().min(1).max(200), startIso: z.string().datetime({ offset: true }), endIso: z.string().datetime({ offset: true }) }).safeParse(elicited.content);
        if (!filled.success || new Date(filled.data.endIso) <= new Date(filled.data.startIso)) return result({ ok: false, error: { code: "VALIDATION", message: "The supplied meeting details are invalid. Please provide a title and a valid start and end time." } }, true);
        data = { ...args, ...filled.data };
      }
      if (new Date(data.endIso!) <= new Date(data.startIso!)) return result({ ok: false, error: { code: "VALIDATION", message: "Meeting end time must be after start time." } }, true);
      const meeting = await createMeeting({ authUserId, ...data });
      return result({ ok: true, meeting });
    } catch (error) { return result({ ok: false, error: failure(error) }, true); }
  },
});
