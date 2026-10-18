import { BellIcon } from "lucide-react";
import { openNotificationAction } from "@/app/notifications/actions";
import type { NotificationKind } from "@/domain/notifications";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { getDb } from "@/infra/db/client";
import { listNotifications } from "@/services/notifications";
import { cn } from "@/lib/utils";

const kindLabel: Record<NotificationKind, string> = {
  assigned_to_you: "Assigned to you",
  ticket_assigned: "Your Ticket was assigned",
  entered_team_queue: "New in your Team's queue",
  ticket_resolved: "Your Ticket was resolved",
  ticket_closed: "Your Ticket was closed",
};

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

// The signed-in User's Notifications in the header: an unread count and a
// list. A native <details> keeps it a Server Component; each entry is a form
// so opening it marks it read on the server.
export async function NotificationBell({ userId }: { userId: string }) {
  const { notifications, unreadCount } = await listNotifications(
    getDb(),
    userId,
  );

  return (
    <details className="group relative">
      <summary
        aria-label={`Notifications, ${unreadCount} unread`}
        className="relative flex size-9 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-muted [&::-webkit-details-marker]:hidden"
      >
        <BellIcon className="size-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] font-medium text-primary-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md">
        <p className="border-b px-3 py-2 text-sm font-medium">Notifications</p>
        {notifications.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No notifications yet
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {notifications.map((n) => (
              <li key={n.id} className="border-b last:border-b-0">
                <form action={openNotificationAction}>
                  <input type="hidden" name="notificationId" value={n.id} />
                  <button
                    type="submit"
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted",
                      !n.readAt && "bg-muted/50",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {!n.readAt && (
                        <span
                          aria-label="Unread"
                          className="size-2 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <span className={cn(!n.readAt && "font-medium")}>
                        {kindLabel[n.kind]}
                      </span>
                    </span>
                    <span className="truncate text-muted-foreground">
                      {formatTicketNumber(n.ticketNumber)} · {n.ticketTitle}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {dateFormat.format(n.createdAt)} UTC
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
