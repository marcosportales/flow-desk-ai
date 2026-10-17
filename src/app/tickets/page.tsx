import Link from "next/link";
import { categories } from "@/domain/classification";
import { priorities } from "@/domain/priority";
import {
  classificationStates,
  dispatchStatuses,
  ticketStatuses,
} from "@/domain/transitions";
import { getDb } from "@/infra/db/client";
import {
  getTicketCounters,
  listTickets,
  type TicketListItem,
} from "@/services/listTickets";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const filters = [
  { name: "status", label: "Ticket Status", options: ticketStatuses },
  {
    name: "classification_state",
    label: "Classification State",
    options: classificationStates,
  },
  { name: "category", label: "Category", options: categories },
  { name: "priority", label: "Priority", options: priorities },
  {
    name: "dispatch_status",
    label: "Dispatch Status",
    options: dispatchStatuses,
  },
] as const;

const label = (value: string) => value.replaceAll("_", " ");

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function Badge({ value, tone }: { value: string | null; tone?: string }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone ?? "bg-slate-100 text-slate-700"}`}
    >
      {label(value)}
    </span>
  );
}

const priorityTone: Record<string, string> = {
  urgent: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
};
const dispatchTone: Record<string, string> = {
  failed: "bg-red-100 text-red-800",
  unknown: "bg-amber-100 text-amber-800",
  succeeded: "bg-green-100 text-green-800",
};

function Counter({ name, value }: { name: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-slate-500">{name}</div>
    </div>
  );
}

function Row({ ticket }: { ticket: TicketListItem }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-2 font-mono text-slate-500">#{ticket.number}</td>
      <td className="px-3 py-2 font-medium">{ticket.title}</td>
      <td className="px-3 py-2">{ticket.requesterName}</td>
      <td className="px-3 py-2">
        <Badge value={ticket.category} />
      </td>
      <td className="px-3 py-2">
        <Badge
          value={ticket.priority}
          tone={ticket.priority ? priorityTone[ticket.priority] : undefined}
        />
      </td>
      <td className="px-3 py-2">
        <Badge value={ticket.status} />
      </td>
      <td className="px-3 py-2">
        <Badge
          value={ticket.classificationState}
          tone={
            ticket.classificationState === "needs_review"
              ? "bg-amber-100 text-amber-800"
              : undefined
          }
        />
      </td>
      <td className="px-3 py-2">
        <Badge
          value={ticket.dispatchStatus}
          tone={
            ticket.dispatchStatus
              ? dispatchTone[ticket.dispatchStatus]
              : undefined
          }
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-slate-500">
        {dateFormat.format(ticket.createdAt)} UTC
      </td>
    </tr>
  );
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  // Repeated params: the first one wins.
  const query = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const db = getDb();
  const [result, counters] = await Promise.all([
    listTickets(db, query),
    getTicketCounters(db),
  ]);

  const pageHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v && k !== "page") next.set(k, v);
    next.set("page", String(page));
    return `/tickets?${next}`;
  };

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tickets</h1>
        <Link
          href="/tickets/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
        >
          New Request
        </Link>
      </div>

      <section
        aria-label="Counters"
        className="grid grid-cols-2 gap-4 md:grid-cols-4"
      >
        <Counter name="Open" value={counters.open} />
        <Counter name="Needs review" value={counters.needsReview} />
        <Counter name="Failed Dispatches" value={counters.failedDispatches} />
        <Counter name="Urgent" value={counters.urgent} />
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          Search title
          <input
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
          />
        </label>
        {filters.map((f) => (
          <label key={f.name} className="flex flex-col text-sm">
            {f.label}
            <select
              name={f.name}
              defaultValue={query[f.name] ?? ""}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
            >
              <option value="">All</option>
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {label(o)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
          Apply
        </button>
        <Link href="/tickets" className="py-2 text-sm text-slate-600 underline">
          Clear
        </Link>
      </form>

      {result.kind === "invalid" ? (
        <p role="alert" className="rounded-md bg-red-50 p-4 text-red-800">
          Some filters are invalid.{" "}
          <Link href="/tickets" className="underline">
            Clear filters
          </Link>
        </p>
      ) : result.tickets.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-slate-500">
          {Object.entries(query).some(
            ([k, v]) => v && k !== "page" && k !== "page_size",
          )
            ? "No Tickets match these filters."
            : result.total > 0
              ? "This page is empty."
              : "No Tickets yet. Submit the first Request."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {[
                    "Ticket",
                    "Title",
                    "Requester",
                    "Category",
                    "Priority",
                    "Status",
                    "Classification",
                    "Dispatch",
                    "Created",
                  ].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.tickets.map((t) => (
                  <Row key={t.id} ticket={t} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="flex items-center justify-between text-sm text-slate-600">
            <span>
              {result.total} Ticket{result.total === 1 ? "" : "s"} · page{" "}
              {result.page} of{" "}
              {Math.max(1, Math.ceil(result.total / result.pageSize))}
            </span>
            <span className="space-x-4">
              {result.page > 1 && (
                <Link href={pageHref(result.page - 1)} className="underline">
                  Previous
                </Link>
              )}
              {result.page * result.pageSize < result.total && (
                <Link href={pageHref(result.page + 1)} className="underline">
                  Next
                </Link>
              )}
            </span>
          </nav>
        </>
      )}
    </main>
  );
}
