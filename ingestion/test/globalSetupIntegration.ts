import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Never touch anything but a dedicated *_test database — a misconfigured
// DATABASE_URL here would otherwise DROP/CREATE a real one. The
// test:integration npm script is the source of truth for this value
// (cross-env, for Windows/CI portability); this is just a safety net against
// running the suite directly without it.
const testDbUrl = process.env.DATABASE_URL;
if (!testDbUrl || !/\/\w*_test$/.test(testDbUrl)) {
  throw new Error(
    "DATABASE_URL must point at a *_test database for integration tests " +
      "(got: " + (testDbUrl ?? "unset") + "). Run via `npm run test:integration`.",
  );
}
const testDbName = testDbUrl.split("/").pop()!;
const adminUrl = testDbUrl.replace(/\/\w*_test$/, "/postgres");

// Runs once before the whole integration suite (Vitest globalSetup executes
// in its own process, before any test file/worker starts) — drops and
// recreates the test database from db/init/001_schema.sql, the same file
// docker-compose and k8s both seed Postgres from, so the schema under test
// can never drift from what's actually deployed.
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  const schemaSql = readFileSync(path.join(__dirname, "../../db/init/001_schema.sql"), "utf8");
  const testClient = new pg.Client({ connectionString: testDbUrl });
  await testClient.connect();
  try {
    await testClient.query(schemaSql);
  } finally {
    await testClient.end();
  }
}
