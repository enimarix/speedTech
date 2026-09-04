import { Pool } from "pg";

// Single shared pool; connection comes from DATABASE_URL (see .env.example / compose).
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
