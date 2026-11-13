import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMeeting, listUpcomingMeetings } from "../services/calendar.service.js";

function authenticatedSubject(token?: string) {
  try {
    const part = token?.split(".")[1];
    const sub = part ? (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: unknown }).sub : null;
    if (typeof sub !== "string" || !sub.trim()) throw new Error();
    return sub;
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, "Authenticated user context is unavailable");
  }
}

function jsonResource(uri: URL, data: unknown) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }] };
}

export function registerCalendarResources(server: McpServer) {
  server.registerResource("upcoming_meetings", "calendar://meetings/upcoming", {
    title: "Upcoming calendar meetings", description: "Upcoming meetings in the authenticated user's primary calendar.", mimeType: "application/json",
  }, async (uri, extra) => {
    try {
      return jsonResource(uri, { meetings: await listUpcomingMeetings({ authUserId: authenticatedSubject(extra.authInfo?.token), maxResults: 20 }) });
    } catch {
      throw new McpError(ErrorCode.InternalError, "Could not load upcoming calendar meetings");
    }
  });

  server.registerResource("calendar_event", new ResourceTemplate("calendar://events/{eventId}", { list: undefined }), {
    title: "Calendar event", description: "A single event in the authenticated user's primary calendar.", mimeType: "application/json",
  }, async (uri, variables, extra) => {
    const parsed = z.string().regex(/^[A-Za-z0-9_-]{5,1024}$/).safeParse(variables.eventId);
    if (!parsed.success || uri.protocol !== "calendar:" || uri.hostname !== "events") {
      throw new McpError(ErrorCode.InvalidParams, "Invalid calendar event URI");
    }
    try {
      const event = await getMeeting({ authUserId: authenticatedSubject(extra.authInfo?.token), eventId: parsed.data });
      return jsonResource(uri, event);
    } catch (error) {
      if ((error as { code?: number }).code === 404) throw new McpError(ErrorCode.InvalidParams, "Calendar event was not found");
      throw new McpError(ErrorCode.InternalError, "Could not load calendar event");
    }
  });
}
