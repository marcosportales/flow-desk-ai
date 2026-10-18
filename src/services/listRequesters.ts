import { asc } from "drizzle-orm";
import { users } from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Every User a Ticket can be raised for, by name.
export async function listRequesters(
  db: Db,
): Promise<{ id: string; name: string; department: string }[]> {
  return db
    .select({
      id: users.id,
      name: users.name,
      department: users.department,
    })
    .from(users)
    .orderBy(asc(users.name));
}
