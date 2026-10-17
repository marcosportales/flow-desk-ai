export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://flowdesk:flowdesk@localhost:5432/flowdesk_test";
