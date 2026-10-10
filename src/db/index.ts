import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { assertDatabaseAccessAllowed } from './guard';

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  dbInstance?: DbClient;
  rawClient?: ReturnType<typeof postgres>;
};

/**
 * Server-only database connection initializer for PostgreSQL / Supabase.
 * Lazily initializes the database client when explicitly invoked by server-side code.
 */
function createDbClient() {
  if (typeof window !== 'undefined') {
    throw new Error('Database client must only be executed on the server side.');
  }

  const connectionString = process.env.DATABASE_URL;
  assertDatabaseAccessAllowed(connectionString, { operation: 'application' });

  const queryClient = postgres(connectionString!, { max: 10, idle_timeout: 20 });
  const db = drizzle(queryClient, { schema });

  globalForDb.rawClient = queryClient;
  globalForDb.dbInstance = db;

  return db;
}

export function getDb(): DbClient {
  if (!globalForDb.dbInstance) {
    return createDbClient();
  }
  return globalForDb.dbInstance;
}

/**
 * Safely closes the underlying PostgreSQL client connection pool if one was initialized,
 * and clears cached references so future calls re-initialize cleanly.
 */
export async function closeDb(): Promise<void> {
  if (globalForDb.rawClient) {
    try {
      await globalForDb.rawClient.end();
    } catch {
      // Ignore if already closed
    }
  }
  globalForDb.rawClient = undefined;
  globalForDb.dbInstance = undefined;
}

export { schema };
