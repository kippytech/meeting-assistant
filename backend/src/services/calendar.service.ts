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
  const maxAttempts = 5;
  const leaseMilliseconds = 90_000;
  const leaseRenewalMilliseconds = 25_000;
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
  const claimToken = randomUUID();
  const reservation = await pool.query(
    `INSERT INTO meeting_idempotency
       (auth_user_id, operation_key, payload_hash, google_event_id, status, claim_token, lease_until, retry_count)
     VALUES ($1, $2, $3, $4, 'processing', $5, NOW() + ($6 * INTERVAL '1 millisecond'), 1)
     ON CONFLICT (auth_user_id, operation_key) DO UPDATE
       SET status = 'processing', claim_token = EXCLUDED.claim_token,
           lease_until = EXCLUDED.lease_until, retry_count = meeting_idempotency.retry_count + 1,
           updated_at = NOW()
       WHERE meeting_idempotency.payload_hash = EXCLUDED.payload_hash
         AND meeting_idempotency.retry_count < $7
         AND ((meeting_idempotency.status = 'pending' AND
               (meeting_idempotency.next_retry_at IS NULL OR meeting_idempotency.next_retry_at <= NOW()))
           OR (meeting_idempotency.status = 'processing' AND meeting_idempotency.lease_until <= NOW()))
     RETURNING google_event_id`,
    [input.authUserId, fingerprint, payloadHash, eventId, claimToken, leaseMilliseconds, maxAttempts],
  );
  const claimed = reservation.rowCount === 1;
  const existing = claimed ? null : (await pool.query<{ google_event_id: string; status: string; payload_hash: string; next_retry_at: Date | null }>(
    `SELECT google_event_id, status, payload_hash, next_retry_at FROM meeting_idempotency WHERE auth_user_id = $1 AND operation_key = $2`,
    [input.authUserId, fingerprint],
  )).rows[0];
  if (existing && existing.payload_hash !== payloadHash) throw Object.assign(new Error("Idempotency key reused with different meeting details"), { kind: "validation" });
  if (existing?.status === "complete") {
    const calendar = await calendarForUser(input.authUserId);
    const response = await calendar.events.get({ calendarId: "primary", eventId: existing.google_event_id });
    return { ...formatEvent(response.data), inviteEmailsSent: normalized.attendeeEmails.length > 0, googleMeetAdded: normalized.addGoogleMeet };
  }
  if (!claimed) {
    if (existing?.status === "failed") {
      throw Object.assign(new Error("Meeting creation failed after the maximum number of attempts"), { kind: "failed" });
    }
    if (existing?.status === "pending" && existing.next_retry_at && existing.next_retry_at > new Date()) {
      throw Object.assign(new Error("Meeting creation is waiting for its scheduled retry"), { kind: "retry_scheduled", nextRetryAt: existing.next_retry_at });
    }
    throw Object.assign(new Error("Meeting creation is already in progress; retry shortly"), { kind: "in_progress" });
  }

  let leaseLost = false;
  let renewalInFlight = false;
  const heartbeat = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    void pool.query(
      `UPDATE meeting_idempotency SET lease_until = NOW() + ($4 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE auth_user_id = $1 AND operation_key = $2 AND status = 'processing' AND claim_token = $3 AND lease_until > NOW()`,
      [input.authUserId, fingerprint, claimToken, leaseMilliseconds],
    ).then((renewal) => { if (renewal.rowCount !== 1) leaseLost = true; })
      .catch(() => { /* A later heartbeat can renew after a transient database error. */ })
      .finally(() => { renewalInFlight = false; });
  }, leaseRenewalMilliseconds);
  heartbeat.unref?.();

  try {
    const calendar = await calendarForUser(input.authUserId);
    const withMeet = input.addGoogleMeet !== false;
    let response;
    try {
      response = await calendar.events.insert({
        calendarId: "primary",
        sendUpdates: "all",
        conferenceDataVersion: withMeet ? 1 : undefined,
        requestBody: {
          id: eventId,
          summary: input.title,
          description: input.description,
          start: { dateTime: input.startIso },
          end: { dateTime: input.endIso },
          attendees: (input.attendeeEmails ?? []).map((email) => ({ email })),
          conferenceData: withMeet ? {
            createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
          } : undefined,
        },
      });
    } catch (error) {
      // The deterministic event ID also recovers if Google succeeded but its response was lost.
      if ((error as { code?: number }).code !== 409) throw error;
      response = await calendar.events.get({ calendarId: "primary", eventId });
    }

    if (leaseLost) throw Object.assign(new Error("Meeting creation lease expired"), { kind: "in_progress" });
    const completed = await pool.query(
      `UPDATE meeting_idempotency SET status = 'complete', claim_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE auth_user_id = $1 AND operation_key = $2 AND status = 'processing' AND claim_token = $3 AND lease_until > NOW()`,
      [input.authUserId, fingerprint, claimToken],
    );
    if (completed.rowCount !== 1) throw Object.assign(new Error("Meeting creation lease was claimed by another request"), { kind: "in_progress" });
    return { ...formatEvent(response.data), inviteEmailsSent: (input.attendeeEmails ?? []).length > 0, googleMeetAdded: withMeet };
  } catch (error) {
    // Release only our own claim. A crash instead leaves a lease that expires naturally.
    await pool.query(
      `UPDATE meeting_idempotency
       SET status = CASE WHEN retry_count >= $4 THEN 'failed' ELSE 'pending' END,
           next_retry_at = CASE WHEN retry_count >= $4 THEN NULL ELSE
             NOW() + (LEAST(3600, 30 * POWER(2, GREATEST(0, retry_count - 1))) * INTERVAL '1 second') END,
           claim_token = NULL, lease_until = NULL, updated_at = NOW()
       WHERE auth_user_id = $1 AND operation_key = $2 AND status = 'processing' AND claim_token = $3`,
      [input.authUserId, fingerprint, claimToken, maxAttempts],
    );
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
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
