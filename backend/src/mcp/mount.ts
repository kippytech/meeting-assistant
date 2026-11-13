import { descopeMcpAuthRouter, DescopeMcpProvider } from "@descope/mcp-express";
import { createMeetingTool, listUpcomingMeetingsTools } from "./calendar-tools.js";
import { registerCalendarResources } from "./calendar-resources.js";
import { registerMeetingPrompts } from "./prompts.js";
import type { Express } from "express";

export function mountMcpServer(app: Express) {
  const wellKnown = process.env.DESCOPE_MCP_SERVER_WELL_KNOWN_URL;

  if (!wellKnown) {
    console.warn("DESCOPE_MCP_SERVER_WELL_KNOWN_URL is disabled");
    return;
  }

  const serverUrl = process.env.SERVER_URL;

  const provider = new DescopeMcpProvider({
    serverUrl,
    descopeMcpServerWellKnownUrl: wellKnown,
    projectId: process.env.DESCOPE_PROJECT_ID,
  });

  app.use(
    descopeMcpAuthRouter((server) => {
      // The Descope adapter creates a fresh authenticated MCP server per request.
      listUpcomingMeetingsTools(server);
      createMeetingTool(server);
      registerCalendarResources(server);
      registerMeetingPrompts(server);
    }, provider),
  );

  // cursor -> sends GET /mcp

  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "Post").send("Method not allowed");
  });

  console.log(`MCP endpoint: POST ${serverUrl}/mcp`);
}


// Here's a realistic sequence of what happens when Cursor connects to your MCP server.
// 1. Discovery
   
//    Cursor contacts your MCP endpoint and discovers that authentication is required.
   
//    It retrieves your Protected Resource Metadata.
// 2. Authorization server discovery
   
//    Cursor discovers Descope as the authorization server.
// 3. Client registration
   
//    Cursor identifies itself through CIMD or DCR.
// 4. OAuth authorization
   
//    Cursor generates PKCE values and redirects the user to Descope.



// Authentication and consent

// The user authenticates and approves the requested MCP permissions.

// Descope issues an authorization code.



// Token exchange

// Cursor exchanges the authorization code and PKCE verifier for an access token.

// The token has an audience corresponding to your MCP server.



// MCP request
// Cursor sends:
// POST /mcp
// Authorization: Bearer ACCESS_TOKEN

// Token validation

// Descope's Express middleware validates the token and provides authenticated context to your handler.

// Tool execution

// Your tool identifies the user and retrieves the appropriate Google credentials through Descope 
// 1. Connections.
// 2. Google API request
   
//    Your backend calls Google Calendar using the Google access token, refreshing it through Connections when necessary.
// The key distinction is that Cursor never needs to possess the user's Google refresh token. It only needs its MCP access token.
