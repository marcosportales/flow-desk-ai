import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import { z } from "zod";
import { canCloseOrReopen, canRunManualActions } from "@/domain/permissions";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { requireUser } from "@/infra/auth/session";
import { getDb } from "@/infra/db/client";
import { getUserTeams } from "@/services/getUserTeams";
import { listTeamMembers } from "@/services/listTeamMembers";
import { getTicketDetail } from "@/services/getTicketDetail";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AutoRefresh } from "./AutoRefresh";
import { ManualActions } from "./ManualActions";
import { RequesterResponse } from "./RequesterResponse";
import { label } from "@/lib/format";

export const dynamic = "force-dynamic";

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});
const when = (d: Date | null) => (d ? `${dateFormat.format(d)} UTC` : "—");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <Alert>
      <InfoIcon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function DefinitionItem({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground uppercase">{name}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const viewer = { id: user.id, teams: await getUserTeams(db, user.id) };
  const result = await getTicketDetail(db, id, viewer);
  if (result.kind === "not_found") notFound();
  const {
    ticket,
    requester,
    assignee,
    classificationAttempts,
    dispatches,
    events,
    priorityEvaluation,
    reason,
    settled,
  } = result.detail;
  // Requester-only Users get a read-only page (ADR 0008).
  const ticketPolicy = {
    requesterId: ticket.requesterId,
    category: ticket.category,
    team: ticket.team,
  };
  const canAct = canRunManualActions(viewer, ticketPolicy);
  const teamMembers = canAct ? await listTeamMembers(db, ticket.id) : [];
  const overridden = ticket.priorityOverrideReason !== null;
  const latestDispatch = dispatches.at(-1);
  const failedDispatchId =
    latestDispatch?.status === "failed" && !latestDispatch.supersededBy
      ? latestDispatch.id
      : null;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/tickets" />}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          All Tickets
        </Button>
        {!settled && <AutoRefresh everyMs={3000} />}
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-muted-foreground">
            {formatTicketNumber(ticket.number ?? 0)}
          </span>
          <h1 className="font-heading text-2xl font-semibold">
            {ticket.title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Ticket Status:</span>
          <StatusBadge value={ticket.status} />
          <span>Classification State:</span>
          <StatusBadge value={ticket.classificationState} />
          <span>Assignee:</span>
          <strong>{assignee ? assignee.name : "Unassigned"}</strong>
          {ticket.externalReference && (
            <>
              <span>External Reference:</span>
              <strong className="font-mono">{ticket.externalReference}</strong>
            </>
          )}
        </div>
      </header>

      <Section title="Request">
        <p className="text-sm text-muted-foreground">
          From {requester.name} ({requester.department}) ·{" "}
          {when(ticket.createdAt)}
        </p>
        <p className="whitespace-pre-wrap">{ticket.description}</p>
      </Section>

      <Section title="Classification">
        {ticket.classificationState === "pending" ? (
          <Muted>Waiting for classification…</Muted>
        ) : ticket.category === null ? (
          <Callout>
            No usable Classification. This Ticket is in Manual Review.
          </Callout>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <DefinitionItem name="Category">
              <StatusBadge value={ticket.category} />
            </DefinitionItem>
            <DefinitionItem name="Source">
              <StatusBadge value={ticket.classificationSource} />
            </DefinitionItem>
            <DefinitionItem name="Summary">{ticket.summary}</DefinitionItem>
            <DefinitionItem name="Blocks work">
              {ticket.blocksWork ? "Yes" : "No"}
            </DefinitionItem>
            <DefinitionItem name="Impact Scope">
              {ticket.impactScope ? label(ticket.impactScope) : "—"}
            </DefinitionItem>
            <DefinitionItem name="Reason">{reason ?? "—"}</DefinitionItem>
          </dl>
        )}
        {classificationAttempts.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">AI attempts</h3>
              {classificationAttempts.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-2 rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">#{a.attemptNo}</span>
                    <span>{a.kind}</span>
                    <StatusBadge value={a.outcome} />
                    <span className="text-muted-foreground">
                      {a.provider} / {a.model}
                      {a.latencyMs !== null && ` · ${a.latencyMs} ms`}
                    </span>
                  </div>
                  {a.error && <p className="text-destructive">{a.error}</p>}
                  {a.outcome === "invalid_output" && (
                    <details open>
                      <summary className="cursor-pointer text-muted-foreground">
                        Raw output
                      </summary>
                      <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                        {a.rawOutput ?? "(empty)"}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="Priority and Team">
        {ticket.priority === null ? (
          <Muted>No Priority yet.</Muted>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-3">
            <DefinitionItem name="Priority">
              <StatusBadge value={ticket.priority} />
            </DefinitionItem>
            <DefinitionItem name="Matched Priority Rule">
              <span className="font-mono">{ticket.priorityRule ?? "—"}</span>
            </DefinitionItem>
            <DefinitionItem name="Team">
              {ticket.team ? label(ticket.team) : "—"}
            </DefinitionItem>
          </dl>
        )}
        {overridden && (
          <Callout>
            Priority Override: computed{" "}
            <strong>{ticket.computedPriority}</strong> replaced by{" "}
            <strong>{ticket.priority}</strong>. Reason:{" "}
            {ticket.priorityOverrideReason}
          </Callout>
        )}
        {priorityEvaluation?.evaluated && (
          <Table>
            <caption className="pb-2 text-left font-medium">
              Rule evaluation (first match wins)
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Would give</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {priorityEvaluation.evaluated.map((r) => (
                <TableRow
                  key={r.rule}
                  data-state={
                    r.rule === priorityEvaluation.rule ? "selected" : undefined
                  }
                >
                  <TableCell className="font-mono">{r.rule}</TableCell>
                  <TableCell>{r.priority}</TableCell>
                  <TableCell>
                    {r.rule === priorityEvaluation.rule
                      ? "matched — decided"
                      : r.matched
                        ? "matched, shadowed"
                        : "no match"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Dispatches">
        {dispatches.length === 0 ? (
          <Muted>No Dispatch for this Ticket.</Muted>
        ) : (
          dispatches.map((d) => (
            <div
              key={d.id}
              className="flex flex-col gap-2 rounded-md border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">#{d.sequence}</span>
                <StatusBadge value={d.status} />
                {d.supersededBy && (
                  <span className="text-xs text-muted-foreground">
                    superseded
                  </span>
                )}
                <span>
                  {label(d.category)} · {d.priority} · {label(d.team)} ·{" "}
                  {d.route} route
                </span>
              </div>
              <p className="font-mono text-xs text-muted-foreground">{d.id}</p>
              {d.attempts.length === 0 ? (
                <Muted>No Dispatch Attempts yet.</Muted>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        "Attempt",
                        "Trigger",
                        "Outcome",
                        "HTTP",
                        "Execution Reference",
                        "Error",
                        "Started",
                      ].map((h) => (
                        <TableHead key={h}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.attempts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono">
                          #{a.attemptNo}
                        </TableCell>
                        <TableCell>{a.trigger}</TableCell>
                        <TableCell>
                          <StatusBadge value={a.outcome} />
                        </TableCell>
                        <TableCell>{a.httpStatus ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {a.executionReference ?? "—"}
                        </TableCell>
                        <TableCell className="text-destructive">
                          {a.error ?? ""}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {when(a.startedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ))
        )}
      </Section>

      {canAct && (
        <Section title="Manual actions">
          <ManualActions
            ticketId={ticket.id}
            ticketStatus={ticket.status}
            classificationState={ticket.classificationState}
            priority={ticket.priority}
            failedDispatchId={failedDispatchId}
            assigneeId={assignee?.id ?? null}
            teamMembers={teamMembers}
          />
        </Section>
      )}

      {!canAct &&
        canCloseOrReopen(viewer, ticketPolicy) &&
        ticket.status === "resolved" && (
          <Section title="Is it fixed?">
            <RequesterResponse ticketId={ticket.id} />
          </Section>
        )}

      <Section title="Timeline">
        <ol className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="rounded-md border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{label(e.type)}</span>
                <span className="text-xs text-muted-foreground">
                  {e.actorLabel} · {when(e.createdAt)}
                </span>
              </div>
              <Json value={e.data} />
            </li>
          ))}
        </ol>
      </Section>
    </main>
  );
}
