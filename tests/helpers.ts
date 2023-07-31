import { OperonConfig } from 'src';
import { Client, QueryArrayResult } from 'pg';

export function generateOperonTestConfig(): OperonConfig {
  const dbPassword: string | undefined = process.env.DB_PASSWORD || process.env.PGPASSWORD;
  if (!dbPassword) {
    throw(new Error('DB_PASSWORD or PGPASSWORD environment variable not set'));
  }

  const operonTestConfig: OperonConfig = {
    poolConfig: {
      host: "localhost",
      port: 5432,
      user: 'postgres',
      password: process.env.PGPASSWORD,
      // We can use another way of randomizing the DB name if needed
      database: "operontest_" + Math.round(Date.now()).toString(),
    },
  }

  return operonTestConfig;
}

export async function teardownOperonTestDb(config: OperonConfig) {
  const pgSystemClient = new Client({
    user: config.poolConfig.user,
    port: config.poolConfig.port,
    host: config.poolConfig.host,
    password: config.poolConfig.password,
    database: 'postgres',
  });
  await pgSystemClient.connect();

  try {
    const dbExists: QueryArrayResult = await pgSystemClient.query(
      `SELECT FROM pg_database WHERE datname = '${config.poolConfig.database}'`
    );
    if (dbExists.rows.length > 0) {
      await pgSystemClient.query(`DROP DATABASE ${config.poolConfig.database};`);
    }
  } finally {
    await pgSystemClient.end();
  }
}
