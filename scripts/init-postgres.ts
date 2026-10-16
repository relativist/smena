import { openPostgresDatabase } from "../server/database.ts";
import { initializePostgresSchema } from "../server/postgresSchema.ts";

const url = process.env.SMENA_DATABASE_URL;
if (!url) throw new Error("Укажите SMENA_DATABASE_URL для PostgreSQL");
const db = openPostgresDatabase(url);
try {
  await initializePostgresSchema(db);
  console.info("Схема PostgreSQL готова. Данные школы не изменены.");
} finally {
  await db.close();
}
