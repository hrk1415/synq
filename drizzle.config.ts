import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'drizzle-kit';
import { assertDatabaseAccessAllowed } from './src/db/guard';
loadEnvConfig(process.cwd());

// Drizzle-kit commands:
// 'generate' builds schema migrations offline without database connections.
// 'migrate', 'push', 'pull', 'studio', etc. connect directly to the target database.
const isOfflineCommand = process.argv.some((arg) =>
  ['generate', 'check', 'up', '--help', '-h', '--version', '-v'].includes(arg)
);

if (!isOfflineCommand) {
  assertDatabaseAccessAllowed(process.env.DATABASE_URL, { operation: 'migration' });
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || '',
  },
});
