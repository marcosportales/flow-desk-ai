import Link from "next/link";
import { AlertCircleIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { label } from "@/lib/format";

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

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function Counter({ name, value }: { name: string; value: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{name}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function Row({ ticket }: { ticket: TicketListItem }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-muted-foreground">
        #{ticket.number}
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/tickets/${ticket.id}`} className="hover:underline">
          {ticket.title}
        </Link>
      </TableCell>
      <TableCell>{ticket.requesterName}</TableCell>
      <TableCell>
        <StatusBadge value={ticket.category} />
      </TableCell>
      <TableCell>
        <StatusBadge value={ticket.priority} />
      </TableCell>
      <TableCell>
        <StatusBadge value={ticket.status} />
      </TableCell>
      <TableCell>
        <StatusBadge value={ticket.classificationState} />
      </TableCell>
      <TableCell>
        <StatusBadge value={ticket.dispatchStatus} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {dateFormat.format(ticket.createdAt)} UTC
      </TableCell>
    </TableRow>
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

  const hasFilters = Object.entries(query).some(
    ([k, v]) => v && k !== "page" && k !== "page_size",
  );

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <h1 className="font-heading text-2xl font-semibold">Tickets</h1>

      <section
        aria-label="Counters"
        className="grid grid-cols-2 gap-4 md:grid-cols-4"
      >
        <Counter name="Open" value={counters.open} />
        <Counter name="Needs review" value={counters.needsReview} />
        <Counter name="Failed Dispatches" value={counters.failedDispatches} />
        <Counter name="Urgent" value={counters.urgent} />
      </section>

      <form method="get">
        <FieldGroup className="flex-row flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel htmlFor="q">Search title</FieldLabel>
            <Input id="q" type="search" name="q" defaultValue={query.q ?? ""} />
          </Field>
          {filters.map((f) => (
            <Field key={f.name} className="w-auto">
              <FieldLabel htmlFor={f.name}>{f.label}</FieldLabel>
              <NativeSelect
                id={f.name}
                name={f.name}
                defaultValue={query[f.name] ?? ""}
              >
                <NativeSelectOption value="">All</NativeSelectOption>
                {f.options.map((o) => (
                  <NativeSelectOption key={o} value={o}>
                    {label(o)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/tickets" />}
            >
              Clear
            </Button>
          </div>
        </FieldGroup>
      </form>

      {result.kind === "invalid" ? (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertTitle>Some filters are invalid.</AlertTitle>
          <AlertDescription>
            <Link href="/tickets" className="underline">
              Clear filters
            </Link>
          </AlertDescription>
        </Alert>
      ) : result.tickets.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              {hasFilters
                ? "No Tickets match these filters."
                : result.total > 0
                  ? "This page is empty."
                  : "No Tickets yet. Submit the first Request."}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.tickets.map((t) => (
                  <Row key={t.id} ticket={t} />
                ))}
              </TableBody>
            </Table>
          </Card>
          <nav className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {result.total} Ticket{result.total === 1 ? "" : "s"} · page{" "}
              {result.page} of{" "}
              {Math.max(1, Math.ceil(result.total / result.pageSize))}
            </span>
            <span className="flex gap-2">
              {result.page > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={pageHref(result.page - 1)} />}
                >
                  Previous
                </Button>
              )}
              {result.page * result.pageSize < result.total && (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={pageHref(result.page + 1)} />}
                >
                  Next
                </Button>
              )}
            </span>
          </nav>
        </>
      )}
    </main>
  );
}
