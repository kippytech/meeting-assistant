import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { getPool } from "../db/pool.js";
import { getCalendarAccessToken } from "./token.service.js";

function calendarClient(accessToken: string) {
  const auth = new google.auth.OAuth2();

  auth.setCredentials({
    access_token: accessToken,
  });

  return google.calendar({
    version: "v3",
    auth,
  });
}

async function calendarForUser(authUserId: string) {
  const accessToken = await getCalendarAccessToken(authUserId);

  return calendarClient(accessToken);
}

function formatEvent(event: {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  htmlLink?: string | null;
  hangoutLink?: string | null;
  attendees?: Array<{
    email?: string | null;
    displayName?: string | null;
  }> | null;
}) {
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    description: event.description?.trim() || null,
    location: event.location?.trim() || null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    htmlLink: event.htmlLink ?? null,
    meetLink: event.hangoutLink ?? null,
    attendees: (event.attendees ?? [])
      .map((person) => person.email || person.displayName)
      .filter((value): value is string => Boolean(value)),
  };
}

export async function listUpcomingMeetings(input: {
  authUserId: string;
  maxResults?: number;
  todayOnly?: boolean;
}) {
  const calendar = await calendarForUser(input.authUserId);

  let timeMin = new Date().toISOString();

  let timeMax: string | undefined;

  if (input.todayOnly) {
    const start = new Date();

    // 00:00:00:00
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    timeMin = start.toISOString();
    timeMax = end.toISOString();
  }

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    maxResults: input.maxResults ?? 10,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items ?? []).map(formatEvent);
}

export async function getMeeting(input: { authUserId: string; eventId: string }) {
  const calendar = await calendarForUser(input.authUserId);
  const response = await calendar.events.get({ calendarId: "primary", eventId: input.eventId });
  return formatEvent(response.data);
}

export async function createMeeting(input: {
  authUserId: string;
  title: string;
  startIso: string;
  endIso: string;
  attendeeEmails?: string[];
  description?: string;
  addGoogleMeet?: boolean;
  idempotencyKey?: string;
}) {
  // Stable per-user logical-operation key, persisted before contacting Google.
  // Google event IDs are also deterministic, allowing recovery after an uncertain insert.
  const pool = getPool();
  const normalized = {
    title: input.title.trim(), startIso: input.startIso, endIso: input.endIso,
    attendeeEmails: [...(input.attendeeEmails ?? [])].map((e) => e.toLowerCase()).sort(),
    description: input.description ?? "", addGoogleMeet: input.addGoogleMeet !== false,
  };
  const fingerprint = input.idempotencyKey
    ? createHash("sha256").update(`client:${input.idempotencyKey}`).digest("hex")
    : createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const eventId = `m${fingerprint.slice(0, 39)}`;
  const payloadHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const reservation = await pool.query(
    `INSERT INTO meeting_idempotency (auth_user_id, operation_key, payload_hash, google_event_id, status)
     VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (auth_user_id, operation_key) DO NOTHING RETURNING google_event_id`,
    [input.authUserId, fingerprint, payloadHash, eventId],
  );
  const isNew = reservation.rowCount === 1;
  const existing = isNew ? null : (await pool.query<{ google_event_id: string; status: string; payload_hash: string }>(
    `SELECT google_event_id, status, payload_hash FROM meeting_idempotency WHERE auth_user_id = $1 AND operation_key = $2`,
    [input.authUserId, fingerprint],
  )).rows[0];
  if (existing && existing.payload_hash !== payloadHash) throw Object.assign(new Error("Idempotency key reused with different meeting details"), { kind: "validation" });
  if (!isNew && existing?.status === "complete") {
    const calendar = await calendarForUser(input.authUserId);
    const response = await calendar.events.get({ calendarId: "primary", eventId: existing.google_event_id });
    return { ...formatEvent(response.data), inviteEmailsSent: normalized.attendeeEmails.length > 0, googleMeetAdded: normalized.addGoogleMeet };
  }
  const calendar = await calendarForUser(input.authUserId);

  // enabling this one by default
  const withMeet = input.addGoogleMeet !== false;

  let response;
  try {
    response = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    conferenceDataVersion: withMeet ? 1 : undefined,
    requestBody: {
      id: isNew ? eventId : existing?.google_event_id ?? eventId,
      summary: input.title,
      description: input.description,
      start: {
        dateTime: input.startIso,
      },
      end: {
        dateTime: input.endIso,
      },
      attendees: (input.attendeeEmails ?? []).map((email) => ({ email })),
      conferenceData: withMeet
        ? {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: {
                type: "hangoutsMeet",
              },
            },
          }
        : undefined,
    },
    });
  } catch (error) {
    // A duplicate deterministic Google event ID means a prior attempt may have
    // reached Google before its response was lost. Read it back and finalize.
    if ((error as { code?: number }).code !== 409) throw error;
    response = await calendar.events.get({ calendarId: "primary", eventId: existing?.google_event_id ?? eventId });
  }

  await pool.query(
    `UPDATE meeting_idempotency SET status = 'complete', updated_at = NOW() WHERE auth_user_id = $1 AND operation_key = $2`,
    [input.authUserId, fingerprint],
  );

  return {
    ...formatEvent(response.data),
    inviteEmailsSent: (input.attendeeEmails ?? []).length > 0,
    googleMeetAdded: withMeet,
  };
}

export async function cancelMeeting(input: {
  authUserId: string;
  eventId: string;
}) {
  const calendar = await calendarForUser(input.authUserId);

  await calendar.events.delete({
    calendarId: "primary",
    eventId: input.eventId,
    sendUpdates: "all",
  });

  return {
    cancelled: true,
    eventId: input.eventId,
  };
}

export async function rescheduleMeeting(input: {
  authUserId: string;
  eventId: string;
  startIso: string;
  endIso: string;
}) {
  const calendar = await calendarForUser(input.authUserId);

  const response = await calendar.events.patch({
    calendarId: "primary",
    eventId: input.eventId,
    sendUpdates: "all",
    requestBody: {
      start: {
        dateTime: input.startIso,
      },
      end: {
        dateTime: input.endIso,
      },
    },
  });

  return formatEvent(response.data);
}

export async function checkCalendarBusy(input: {
  authUserId: string;
  startIso: string;
  endIso: string;
}) {
  const calendar = await calendarForUser(input.authUserId);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: input.startIso,
      timeMax: input.endIso,
      items: [
        {
          id: "primary",
        },
      ],
    },
  });

  const busy = response.data?.calendars?.primary?.busy ?? [];

  return {
    busy: busy.map((item) => ({
      start: item.start ?? null,
      end: item.end ?? null,
    })),
  };
}
