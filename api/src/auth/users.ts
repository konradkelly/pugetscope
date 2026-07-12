import { pool } from "../db/postgres.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await pool.query(
    "SELECT id, email, password_hash AS \"passwordHash\" FROM users WHERE email = $1",
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<Omit<User, "passwordHash"> | null> {
  const result = await pool.query("SELECT id, email FROM users WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     RETURNING id, email, password_hash AS "passwordHash"`,
    [email, passwordHash],
  );
  return result.rows[0];
}
