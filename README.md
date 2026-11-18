# Agentic Calendar Assistant

A full-stack calendar assistant that lets an authenticated user inspect and manage calendar meetings through a streaming chat interface. The application combines a Next.js frontend, an Express API, a Mastra-powered agent, Descope authentication and outbound connections, and a calendar provider integration. An optional authenticated Model Context Protocol (MCP) endpoint exposes selected calendar capabilities to compatible clients.

## What it does

- Streams assistant responses and execution progress to the dashboard over Server-Sent Events (SSE).
- Lists upcoming events and checks availability in the signed-in user's primary calendar.
- Creates, reschedules, and cancels events; event invitations and Google Meet links are supported.
- Persists chat threads and working memory so the assistant can retain useful scheduling preferences.
- Uses Descope sessions to identify users and obtain Google Calendar authorization without requiring end users to configure Google API credentials or storing Google access tokens in the application database.
- Optionally serves calendar tools, resources, and a meeting-agenda prompt over MCP.

## System overview

```text
Browser (Next.js / React)
  ├── Descope sign-in and session token
  ├── Dashboard, chat, connection status
  └── POST /api/agent/chat ── SSE ──┐
                                    ▼
Express API (backend)
  ├── requireSession validates Descope token
  ├── Mastra agent + LibSQL chat memory ── configured model provider
  ├── Calendar service ── Descope outbound token ── Google Calendar API
  ├── PostgreSQL: users, connections, meeting idempotency
  └── Optional Descope-authenticated MCP endpoint
```

The frontend is a separate Next.js application in `frontend/`; the backend is an Express 5 service in `backend/`. PostgreSQL is provisioned locally through Docker Compose. Mastra's conversation storage and vectors use a local `backend/mastra.db` LibSQL database, distinct from PostgreSQL.

### Request and data boundaries

1. The browser obtains a Descope session and sends its bearer token to protected API routes.
2. `requireSession` validates the session, maps the Descope subject to an application user, and adds that identity to the request context.
3. The agent runs with the authenticated subject as its memory resource and receives calendar tools scoped to that same subject.
4. Calendar access tokens are fetched server-side from the Descope outbound application integration when needed. Calendar operations are performed against the user's `primary` Google Calendar. The user authorizes the connection through Descope; the user does not supply a Google API key.
5. Meeting creation uses a PostgreSQL idempotency record and deterministic Google event ID to safely handle duplicate submissions and uncertain responses.

## Repository layout

```text
backend/
  scripts/migrate.ts       Sequential SQL migration runner
  sql/                     PostgreSQL schema migrations
  src/config/              Descope, agent instructions, and Mastra memory
  src/db/                  PostgreSQL connection pool
  src/mcp/                 MCP tools, resources, prompts, and server mounting
  src/middleware/          Session validation and request identity
  src/repositories/        User and calendar-connection persistence
  src/routes/              Agent and connection HTTP endpoints
  src/services/            Agent, calendar, token, and connection workflows
frontend/
  src/app/                 Next.js routes and root auth provider
  src/components/          Dashboard, chat, connection, and UI components
  src/lib/                 API client, SSE parser, and frontend types
docker-compose.yml         Local PostgreSQL service
```

## Prerequisites

- Node.js with npm (use a current LTS release).
- Docker and Docker Compose for local PostgreSQL, or an equivalent PostgreSQL instance.
- A Descope project configured for the frontend and backend, including a Google Calendar outbound application connection.
- A credential for the model provider selected by the backend (for example, a Google AI or OpenAI key). This is a server-side deployment secret, not a user credential.
- A Google account with Calendar access for end-to-end use.

## Local development

### 1. Configure the backend

Create `backend/.env`:

```dotenv
PORT=4000
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5442/agentic_calendar_app_db

DESCOPE_PROJECT_ID=your-descope-project-id
DESCOPE_MANAGEMENT_KEY=your-descope-management-key
DESCOPE_CALENDAR_CONNECTION_ID=google-calendar

# Example model selection. Omit to use the default Gemini model; the backend
# deployment supplies the provider credential (for example GOOGLE_API_KEY).
AI_MODEL=google/gemini-3.8-flash
```

`DESCOPE_CALENDAR_CONNECTION_ID` defaults to `google-calendar` in code if omitted. Set it to the outbound application ID configured in Descope if your ID differs. Keep `.env` files and management/API keys out of source control.

### 2. Configure the frontend

Create `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_DESCOPE_PROJECT_ID=your-descope-project-id
```

The frontend API URL defaults to `http://localhost:4000`. The Descope project ID must match the backend project. For production deployments, configure the frontend and backend with the correct public origin and update backend CORS policy accordingly.

### 3. Start PostgreSQL and apply migrations

From the repository root:

```bash
docker compose up -d postgres
```

Then apply the backend SQL migrations:

```bash
cd backend
npm install
npm run migrate
```

The migration runner reads `.sql` files from `backend/sql/` in lexical order and executes them against `DATABASE_URL`. Migrations establish the users and calendar connection tables, then evolve the meeting idempotency table to include leases, retry state, and terminal failures.

### 4. Start the services

In one terminal:

```bash
cd backend
npm run dev
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. The API listens on port `4000` by default. The Compose database maps host port `5442` to PostgreSQL's container port `5432`.

## Authentication and Google Calendar connection

Sign-in is provided by the Descope Next.js SDK. Protected backend routes require `Authorization: Bearer <session-token>`. The backend validates the token with Descope and uses the token subject as the stable identity for agent memory and external calendar access.

The dashboard connection flow obtains the user's Descope refresh token in the browser, posts it to the backend's `/api/connections/connect` endpoint, and redirects to the Descope outbound connection URL. After the user completes authorization, the dashboard can refresh the connection status. The backend stores only the app-level status (`pending`, `connected`, or `disconnected`) in PostgreSQL; it retrieves the calendar access token from Descope when performing calendar operations.

## API reference

All `/api/agent/*` and `/api/connections/*` endpoints require a valid Descope bearer session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Checks API reachability and PostgreSQL connectivity. Returns HTTP 503 if the database is unavailable. |
| `GET` | `/api/connections` | Returns the current Google Calendar connection label and status. |
| `POST` | `/api/connections/connect` | Starts the Descope outbound connection flow. Body: `{ "refreshToken": "...", "redirectUrl": "..." }`; `redirectUrl` is optional. |
| `POST` | `/api/connections/refresh-status` | Fetches the current outbound token status and updates the stored connection status. |
| `GET` | `/api/agent/threads` | Lists up to 30 recent conversation threads for the authenticated user. |
| `GET` | `/api/agent/threads/:threadId` | Returns messages for a thread owned by the authenticated user. |
| `POST` | `/api/agent/chat` | Starts a streaming agent response. Body: `{ "message": "...", "threadId": "<uuid>" }`. Response content type is `text/event-stream`. |

Chat input is trimmed, must contain 1–5,000 characters, and requires a UUID thread ID. SSE messages use a JSON object in the `data:` field. Event types are `started`, `progress`, `token`, `completed`, and `error`. If the client disconnects, the backend aborts the agent stream. In production, stream errors are returned with a generic message while details remain in server logs.

## Agent capabilities

The chat agent is defined in `backend/src/services/agent.service.ts` using Mastra's provider/model abstraction. `AI_MODEL` selects the model identifier (for example `google/gemini-3.8-flash` or `openai/gpt-4o-mini`); if unset, the service defaults to `google/gemini-3.8-flash`. The backend deployment must provide whatever credential that model provider requires. End users do not configure model credentials, and Google Calendar authorization is a separate Descope-managed outbound connection. This keeps the agent's calendar tools and memory independent from the selected model provider.

Mastra memory stores the last 20 messages, generates thread titles, and enables resource-scoped working memory for timezone, meeting length, preferred hours, invitees, and notes.

### Agentic execution model

This is a tool-using agent rather than a fixed sequence of calendar API calls. For each user message, the service creates a Mastra `Agent` with scheduling instructions, the user's calendar tools, and persistent memory. The model interprets the request, chooses whether to answer from thread context or invoke a tool, supplies schema-validated arguments, and incorporates tool results into its response. Multi-step plans (for example checking availability and then creating a meeting) are driven by the model's tool calls and results.

The lifecycle is observable and cancellable:

1. The route validates the message and UUID thread ID, authenticates the caller, and opens an SSE response.
2. The service emits `started`, then streams Mastra's full event stream. Tool calls become `progress` events; generated text is forwarded as `token` events.
3. Tool execution uses the authenticated Descope subject captured by the request. The model cannot choose another user's calendar identity.
4. Tool results and model finish/error states are consumed before the service emits `completed`. On disconnect, the route aborts the agent through an `AbortSignal` and observes stream backpressure while writing SSE.
5. Mastra stores the conversation under the authenticated resource and thread. Thread listing and retrieval verify resource ownership.

The tool schemas use Zod to constrain values such as result counts and required event identifiers. Agent instructions guide behavior: request missing meeting details, use saved scheduling preferences, avoid inventing calendar facts, and tailor the response to the user's request. Instructions guide model behavior; schemas and server-side identity checks enforce boundaries during execution.

### Memory model

- **Thread history:** messages are persisted in LibSQL and recalled per thread. A thread belongs to the authenticated Descope subject; a request cannot load another resource's thread.
- **Working memory:** Mastra's resource-scoped template is intended for durable scheduling preferences shared across that user's threads.
- **Vector storage:** a LibSQL vector store and FastEmbed embedder are configured with Mastra memory for semantic-memory capabilities. Semantic recall is currently commented out, so it is not part of the active retrieval path.
- **PostgreSQL state:** users, connection status, and meeting-write idempotency are separate from conversational memory.

The agent's calendar tools are defined in `backend/src/services/agent-tools.service.ts`:

| Tool | Behavior |
| --- | --- |
| `listUpcomingMeetings` | Lists up to 20 upcoming events, optionally limited to today. |
| `checkCalendarBusy` | Queries Google Calendar free/busy for an ISO-8601 interval. |
| `createMeeting` | Creates an event, sends attendee invitations when emails are supplied, and adds Google Meet by default. |
| `rescheduleMeeting` | Updates an event's start and end times and notifies attendees. |
| `cancelMeeting` | Deletes an event and notifies attendees. |

The dashboard agent exposes all five operations. MCP currently exposes a narrower surface: upcoming-meeting listing and meeting creation, plus read-only calendar resources. Reschedule, cancellation, and free/busy remain dashboard-agent tools and are not registered as MCP tools.

The agent instructions favor asking for missing details, using the user's local time preferences, and avoiding invented event facts. Treat these instructions as product behavior and update them alongside changes to scheduling policy.

### Idempotent meeting creation

The calendar service persists a per-user operation key and request payload hash before inserting a Google event. It assigns a deterministic event ID and uses a short renewable lease to prevent concurrent workers from creating duplicates. An uncertain Google response can be reconciled by fetching that same event ID. Failed attempts are retried with exponential backoff, with a bounded attempt count. Reusing a client idempotency key with different meeting details is rejected.

## MCP server

The backend mounts an MCP server when `DESCOPE_MCP_SERVER_WELL_KNOWN_URL` is configured. Set `SERVER_URL` to the externally reachable MCP base URL as well, so the Descope provider can advertise the correct endpoint. Add these to `backend/.env` when enabling MCP:

```dotenv
DESCOPE_MCP_SERVER_WELL_KNOWN_URL=https://your-descope-mcp-metadata-url
SERVER_URL=http://localhost:4000
```

The MCP integration is a first-class interface over the same authenticated calendar service, not a second calendar implementation. It is mounted through Descope's Express MCP adapter when `DESCOPE_MCP_SERVER_WELL_KNOWN_URL` is configured. The adapter creates an authenticated MCP server per request; handlers derive the Descope subject from validated auth context and use Descope outbound connections to reach Google Calendar. The MCP client receives an MCP access token; it does not receive the user's Google refresh token.

### Tools

- **`listUpcomingMeetings`** accepts optional `maxResults` (1–20) and `todayOnly`. It returns structured event data and a stable error envelope for authentication, authorization, validation, external API, and internal failures.
- **`createMeeting`** accepts title, start/end ISO-8601 datetimes, optional attendees, description, Google Meet preference, and optional idempotency key. It validates that the end follows the start. If title or either time is missing, it uses MCP elicitation before attempting the write. The operation delegates to the same idempotent calendar service used by the application.

Tool responses include human-readable JSON text and structured content. Write failures map to stable codes such as `MISSING_INFORMATION`, `VALIDATION`, `IN_PROGRESS`, and `EXTERNAL_API` instead of exposing raw provider errors.

### Resources

- **`calendar://meetings/upcoming`** returns up to 20 upcoming events for the authenticated user's primary calendar as `application/json`.
- **`calendar://events/{eventId}`** resolves one event. The handler validates the URI and event ID before looking up the event under the authenticated user's calendar identity.

Resources provide addressable context that an MCP host can read; they do not mutate calendar state. Event-not-found and invalid-resource requests are translated to MCP errors.

### Prompt

- **`prepare_meeting_agenda`** takes a required meeting title and optional purpose, attendees, duration, and context. It returns a user message asking the host model to prepare timed agenda items, decisions, preparation, and open questions, while asking for clarification where the outcome is unknown and prohibiting invented facts.

Prompts are reusable task templates, distinct from tools: selecting a prompt shapes a host model request but does not itself call Calendar APIs.

### Elicitation

`createMeeting` uses MCP's `elicitation/create` form mode when required fields are missing. It asks the user for the title and both ISO-8601 datetimes including timezone offsets. The handler validates the accepted form payload and ordering before calling the calendar service. Declining or cancelling returns without creating an event; unsupported or failed elicitation returns a missing-information error. This is an explicit user-in-the-loop checkpoint for incomplete write requests.

### Authentication and transport

The MCP endpoint uses POST at `/mcp`; GET returns HTTP 405 with `Allow: Post`. Configure Descope's authorization/discovery metadata and a publicly reachable `SERVER_URL` for remote clients. MCP clients complete the Descope authorization flow and receive the permissions configured for this server. MCP is independent of the dashboard chat API, though both interfaces share the calendar service and user authorization model.

## Development commands

| Working directory | Command | Description |
| --- | --- | --- |
| `backend/` | `npm run dev` | Runs the API with `tsx watch`. |
| `backend/` | `npm run build` | Type-checks and compiles the API to `backend/dist`. |
| `backend/` | `npm start` | Runs the compiled API. |
| `backend/` | `npm run migrate` | Applies SQL files in lexical order. |
| `frontend/` | `npm run dev` | Starts the Next.js development server. |
| `frontend/` | `npm run build` | Builds the Next.js application. |
| `frontend/` | `npm start` | Serves the production Next.js build. |

## Operational notes

- `/health` checks PostgreSQL, not Google Calendar, Descope, the model provider, or Mastra memory.
- PostgreSQL and the local LibSQL memory database have separate persistence and backup requirements. `backend/mastra.db` is created relative to the backend working directory when the backend starts.
- Backend CORS currently permits `http://localhost:3000` and `http://localhost:6274`; update the allowlist before hosting the UI on another origin.
- Set `APP_URL` to the frontend origin for the default connection redirect. The UI supplies its current origin explicitly during the normal connect flow.
- The database migration command is sequential and does not maintain a separate migration ledger. Review migration changes against the target database before deploying them to an existing environment.
- No automated test command is currently defined in either package manifest.

## Deployment checklist

1. Provision PostgreSQL and run all backend migrations.
2. Configure the backend environment variables and keep management/API credentials in a secret manager.
3. Configure the frontend's public Descope project ID and backend API URL.
4. Add the deployed frontend origin to the backend CORS allowlist.
5. Configure Descope sign-in and the Google Calendar outbound application for the intended project.
6. Configure MCP discovery variables only if MCP access is required; use the externally reachable backend URL.
7. Persist and back up both PostgreSQL data and the Mastra LibSQL database according to the deployment's recovery objectives.
8. Verify `/health`, sign-in, the calendar connection flow, and a read-only calendar request in the deployed environment.
