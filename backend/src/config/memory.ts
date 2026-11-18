import { fastembed } from "@mastra/fastembed";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { resolve } from "node:path";

const dbPath = resolve(process.cwd(), "mastra.db");

export const memoryStore = new LibSQLStore({
  id: "meeting-assistant-memory",
  url: `file:${dbPath}`,
});

const memoryVector = new LibSQLVector({
  id: "meeting-assistant-vectors",
  url: `file:${dbPath}`,
});

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
