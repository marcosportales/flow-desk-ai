import { and, count, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { categories } from "@/domain/classification";
import { priorities } from "@/domain/priority";
import {
  classificationStates,
  dispatchStatuses,
  ticketStatuses,
} from "@/domain/transitions";
import { dispatches, users, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

// Query-string values; an empty value means "no filter".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const listTicketsQuery = z.object({
  status: optional(z.enum(ticketStatuses)),
  classification_state: optional(z.enum(classificationStates)),
  category: optional(z.enum(categories)),
  priority: optional(z.enum(priorities)),
  dispatch_status: optional(z.enum(dispatchStatuses)),
  q: optional(z.string().trim().max(200)),
  page: optional(z.coerce.number().int().min(1)),
  page_size: optional(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)),
});

export type ListTicketsQuery = z.infer<typeof listTicketsQuery>;

// The Dispatch Status of a Ticket is that of its latest Dispatch.
const latestDispatchStatus = sql<
  (typeof dispatches.$inferSelect)["status"] | null
>`(
  select ${dispatches.status} from ${dispatches}
  where ${dispatches.ticketId} = ${tickets.id}
  order by ${dispatches.sequence} desc limit 1
)`;

export type TicketListItem = {
  id: string;
  number: number;
  title: string;
  requesterName: string;
  category: (typeof tickets.$inferSelect)["category"];
  priority: (typeof tickets.$inferSelect)["priority"];
  status: (typeof tickets.$inferSelect)["status"];
  classificationState: (typeof tickets.$inferSelect)["classificationState"];
  dispatchStatus: (typeof dispatches.$inferSelect)["status"] | null;
  createdAt: Date;
};

export type ListTicketsResult =
  | {
      kind: "ok";
      tickets: TicketListItem[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { kind: "invalid"; details: unknown };

// Escapes LIKE wildcards so the search text is matched literally.
function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, "\\$&");
}

export async function listTickets(
  db: Db,
  rawQuery: unknown,
): Promise<ListTicketsResult> {
  const parsed = listTicketsQuery.safeParse(rawQuery);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const query = parsed.data;
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

  const conditions: (SQL | undefined)[] = [
    query.status && eq(tickets.status, query.status),
    query.classification_state &&
      eq(tickets.classificationState, query.classification_state),
    query.category && eq(tickets.category, query.category),
    query.priority && eq(tickets.priority, query.priority),
    query.dispatch_status &&
      sql`${latestDispatchStatus} = ${query.dispatch_status}`,
    query.q ? ilike(tickets.title, `%${escapeLike(query.q)}%`) : undefined,
  ];
  const where = and(...conditions);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: tickets.id,
        number: tickets.number,
        title: tickets.title,
        requesterName: users.name,
        category: tickets.category,
        priority: tickets.priority,
        status: tickets.status,
        classificationState: tickets.classificationState,
        dispatchStatus: latestDispatchStatus,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.requesterId))
      .where(where)
      .orderBy(desc(tickets.createdAt), desc(tickets.number))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(tickets).where(where),
  ]);

  return {
    kind: "ok",
    tickets: rows.map((r) => ({ ...r, number: r.number ?? 0 })),
    total: totals?.total ?? 0,
    page,
    pageSize,
  };
}

export type TicketCounters = {
  open: number;
  needsReview: number;
  failedDispatches: number;
  urgent: number;
};

// Counters describe work still needing attention, so they cover open Tickets only.
export async function getTicketCounters(db: Db): Promise<TicketCounters> {
  const countOpen = async (extra?: SQL) => {
    const [r] = await db
      .select({ n: count() })
      .from(tickets)
      .where(and(eq(tickets.status, "open"), extra));
    return r?.n ?? 0;
  };

  const [open, needsReview, failedDispatches, urgent] = await Promise.all([
    countOpen(),
    countOpen(eq(tickets.classificationState, "needs_review")),
    countOpen(sql`${latestDispatchStatus} = 'failed'`),
    countOpen(eq(tickets.priority, "urgent")),
  ]);
  return { open, needsReview, failedDispatches, urgent };
}
