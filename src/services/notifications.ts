import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/domain/actor";
import {
  type NotificationKind,
  type QueuedTicket,
  queueOf,
} from "@/domain/notifications";
import type { Team } from "@/domain/routing";
import type { TicketStatus } from "@/domain/transitions";
import { notifications, teamMemberships, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import type { Tx } from "./dispatchRouting";

// In-app Notifications (GLOSSARY: Notification). They are written in the same
// transaction as the Ticket Event that causes them, so a retry that changes
// nothing notifies nobody, and the unique (user, event) pair keeps any one
// event from notifying a User twice.

export type Recipient = { userId: string; kind: NotificationKind };

// The Ticket Event a Notification is about.
export type CausingEvent = { id: number; ticketId: string };

// The User who caused the event is never notified of it. When a User is
// listed twice, the first entry wins.
export async function notify(
  tx: Tx,
  event: CausingEvent,
  recipients: Recipient[],
  actor: Actor,
): Promise<void> {
  const actorUserId = actor.kind === "user" ? actor.userId : null;
  const rows = recipients
    .filter((r) => r.userId !== actorUserId)
    .map((r) => ({
      userId: r.userId,
      kind: r.kind,
      ticketId: event.ticketId,
      eventId: event.id,
    }));
  if (rows.length === 0) return;
  await tx.insert(notifications).values(rows).onConflictDoNothing();
}

// Every Operator of `team` hears that the Ticket entered their queue, unless
// it was already there before this event.
export async function notifyQueueEntry(
  tx: Tx,
  event: CausingEvent,
  before: QueuedTicket,
  team: Team,
  actor: Actor,
): Promise<void> {
  if (queueOf(before) === team) return;
  const members = await tx
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(eq(teamMemberships.team, team));
  await notify(
    tx,
    event,
    members.map((m) => ({ userId: m.userId, kind: "entered_team_queue" })),
    actor,
  );
}

const statusKinds: Partial<Record<TicketStatus, NotificationKind>> = {
  resolved: "ticket_resolved",
  closed: "ticket_closed",
};

// The Requester hears when their Ticket is resolved or closed; a reopen is
// their own doing and notifies no one.
export async function notifyStatusChange(
  tx: Tx,
  event: CausingEvent,
  requesterId: string,
  to: TicketStatus,
  actor: Actor,
): Promise<void> {
  const kind = statusKinds[to];
  if (!kind) return;
  await notify(tx, event, [{ userId: requesterId, kind }], actor);
}

export const NOTIFICATION_LIST_SIZE = 20;

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  readAt: Date | null;
  createdAt: Date;
};

export type NotificationList = {
  notifications: NotificationItem[];
  unreadCount: number;
};

// A User's own Notifications, newest first, and how many are unread.
export async function listNotifications(
  db: Db,
  userId: string,
): Promise<NotificationList> {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      ticketId: notifications.ticketId,
      ticketNumber: tickets.number,
      ticketTitle: tickets.title,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .innerJoin(tickets, eq(tickets.id, notifications.ticketId))
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.eventId))
    .limit(NOTIFICATION_LIST_SIZE);
  const [unread] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return { notifications: rows, unreadCount: unread?.n ?? 0 };
}

export type OpenNotificationResult =
  { kind: "ok"; ticketId: string } | { kind: "not_found" };

// Marks one of the User's own Notifications read (opening it again keeps the
// first read time) and returns the Ticket it is about. Another User's
// Notification is indistinguishable from a missing one.
export async function openNotification(
  db: Db,
  userId: string,
  notificationId: string,
): Promise<OpenNotificationResult> {
  if (!z.uuid().safeParse(notificationId).success) {
    return { kind: "not_found" };
  }
  const [opened] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    )
    .returning({ ticketId: notifications.ticketId });
  return opened
    ? { kind: "ok", ticketId: opened.ticketId }
    : { kind: "not_found" };
}
