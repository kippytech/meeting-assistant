import { fastembed } from "@mastra/fastembed";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
//import { PostgresStore, PgVector } from "@mastra/pg";
import { Memory } from "@mastra/memory";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

//const dbPath = resolve(process.cwd(), "mastra.db");
const dbPath = resolve(__dirname, "mastra.db");

export const memoryStore = new LibSQLStore({
  id: "meeting-assistant-memory",
  url: `file:${dbPath}`,
});

const memoryVector = new LibSQLVector({
  id: "meeting-assistant-vectors",
  url: `file:${dbPath}`,
});

// export const memoryStore = new PostgresStore({
//   id: "meeting-assistant-memory",
//   connectionString: process.env.DATABASE_URL!,
//   schemaName: "mastra",
// });

// const memoryVector = new PgVector({
//   id: "meeting-assistant-vectors",
//   connectionString: process.env.DATABASE_URL!,
//   schemaName: "mastra",
// });

export function createAgentMemory() {
  return new Memory({
    storage: memoryStore,
    vector: memoryVector,
    embedder: fastembed,
    options: {
      lastMessages: 20,
      generateTitle: true,
      // semanticRecall: {
      //   topK: 5,
      //   messageRange: 2,
      //   scope: 'resource' // Search across all resource (user) threads
      // },
      workingMemory: {
        enabled: true,
        useStateSignals: true, //registers the working-memory tool as setWorkingMemory instead of updateWorkingMemory
        scope: "resource",
        template: `# Meeting preferences
                - Timezone:
                - Default meeting length (minutes):
                - Preferred meeting hours:
                - Usual invitees:
                - Notes:
                `,
      },
    },
  });
}
