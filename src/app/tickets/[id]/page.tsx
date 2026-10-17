import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { getDb } from "@/infra/db/client";
import { getTicketDetail } from "@/services/getTicketDetail";
import { AutoRefresh } from "./AutoRefresh";

export const dynamic = "force-dynamic";

const label = (value: string) => value.replaceAll("_", " ");

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});
const when = (d: Date | null) => (d ? `${dateFormat.format(d)} UTC` : "—");

const statusTone: Record<string, string> = {
  failed: "bg-red-100 text-red-800",
  invalid_output: "bg-red-100 text-red-800",
  provider_error: "bg-red-100 text-red-800",
  urgent: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  unknown: "bg-amber-100 text-amber-800",
  needs_review: "bg-amber-100 text-amber-800",
  succeeded: "bg-green-100 text-green-800",
  valid: "bg-green-100 text-green-800",
};

function Badge({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone[value] ?? "bg-slate-100 text-slate-700"}`}
    >
      {label(value)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{name}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-slate-50 p-2 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await getTicketDetail(getDb(), id);
  if (result.kind === "not_found") notFound();
  const {
    ticket,
    requester,
    classificationAttempts,
    dispatches,
    events,
    priorityEvaluation,
    reason,
    settled,
  } = result.detail;
  const overridden = ticket.priorityOverrideReason !== null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <Link href="/tickets" className="text-sm text-slate-600 underline">
          ← All Tickets
        </Link>
        {!settled && <AutoRefresh everyMs={3000} />}
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-slate-500">
            {formatTicketNumber(ticket.number ?? 0)}
          </span>
          <h1 className="text-2xl font-semibold">{ticket.title}</h1>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <span>Ticket Status:</span>
          <Badge value={ticket.status} />
          <span>Classification State:</span>
          <Badge value={ticket.classificationState} />
        </div>
      </header>

      <Section title="Request">
        <p className="text-sm text-slate-500">
          From {requester.name} ({requester.department}) ·{" "}
          {when(ticket.createdAt)}
        </p>
        <p className="whitespace-pre-wrap">{ticket.description}</p>
      </Section>

      <Section title="Classification">
        {ticket.classificationState === "pending" ? (
          <p className="text-slate-500">Waiting for classification…</p>
        ) : ticket.category === null ? (
          <p className="rounded-md bg-amber-50 p-3 text-amber-900">
            No usable Classification. This Ticket is in Manual Review.
          </p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field name="Category">
              <Badge value={ticket.category} />
            </Field>
            <Field name="Source">
              <Badge value={ticket.classificationSource} />
            </Field>
            <Field name="Summary">{ticket.summary}</Field>
            <Field name="Blocks work">{ticket.blocksWork ? "Yes" : "No"}</Field>
            <Field name="Impact Scope">
              {ticket.impactScope ? label(ticket.impactScope) : "—"}
            </Field>
            <Field name="Reason">{reason ?? "—"}</Field>
          </dl>
        )}
        {classificationAttempts.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium">AI attempts</h3>
            {classificationAttempts.map((a) => (
              <div
                key={a.id}
                className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">#{a.attemptNo}</span>
                  <span>{a.kind}</span>
                  <Badge value={a.outcome} />
                  <span className="text-slate-500">
                    {a.provider} / {a.model}
                    {a.latencyMs !== null && ` · ${a.latencyMs} ms`}
                  </span>
                </div>
                {a.error && <p className="text-red-800">{a.error}</p>}
                {a.outcome === "invalid_output" && (
                  <details open>
                    <summary className="cursor-pointer text-slate-600">
                      Raw output
                    </summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs">
                      {a.rawOutput ?? "(empty)"}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Priority and Team">
        {ticket.priority === null ? (
          <p className="text-slate-500">No Priority yet.</p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field name="Priority">
              <Badge value={ticket.priority} />
            </Field>
            <Field name="Matched Priority Rule">
              <span className="font-mono">{ticket.priorityRule ?? "—"}</span>
            </Field>
            <Field name="Team">{ticket.team ? label(ticket.team) : "—"}</Field>
          </dl>
        )}
        {overridden && (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            Priority Override: computed{" "}
            <strong>{ticket.computedPriority}</strong> replaced by{" "}
            <strong>{ticket.priority}</strong>. Reason:{" "}
            {ticket.priorityOverrideReason}
          </p>
        )}
        {priorityEvaluation && (
          <table className="w-full text-left text-sm">
            <caption className="pb-1 text-left font-medium">
              Rule evaluation (first match wins)
            </caption>
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">Rule</th>
                <th className="py-1 font-medium">Would give</th>
                <th className="py-1 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {priorityEvaluation.evaluated.map((r) => (
                <tr
                  key={r.rule}
                  className={`border-t border-slate-100 ${r.rule === priorityEvaluation.rule ? "bg-green-50 font-medium" : ""}`}
                >
                  <td className="py-1 font-mono">{r.rule}</td>
                  <td className="py-1">{r.priority}</td>
                  <td className="py-1">
                    {r.rule === priorityEvaluation.rule
                      ? "matched — decided"
                      : r.matched
                        ? "matched, shadowed"
                        : "no match"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Dispatches">
        {dispatches.length === 0 ? (
          <p className="text-slate-500">No Dispatch for this Ticket.</p>
        ) : (
          dispatches.map((d) => (
            <div
              key={d.id}
              className="space-y-2 rounded-md border border-slate-200 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">#{d.sequence}</span>
                <Badge value={d.status} />
                <span>
                  {label(d.category)} · {d.priority} · {label(d.team)} ·{" "}
                  {d.route} route
                </span>
              </div>
              <p className="font-mono text-xs text-slate-500">{d.id}</p>
              {d.attempts.length === 0 ? (
                <p className="text-slate-500">No Dispatch Attempts yet.</p>
              ) : (
                <table className="w-full text-left">
                  <thead className="text-slate-500">
                    <tr>
                      {[
                        "Attempt",
                        "Trigger",
                        "Outcome",
                        "HTTP",
                        "n8n execution",
                        "Error",
                        "Started",
                      ].map((h) => (
                        <th key={h} className="py-1 pr-3 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.attempts.map((a) => (
                      <tr key={a.id} className="border-t border-slate-100">
                        <td className="py-1 pr-3 font-mono">#{a.attemptNo}</td>
                        <td className="py-1 pr-3">{a.trigger}</td>
                        <td className="py-1 pr-3">
                          <Badge value={a.outcome} />
                        </td>
                        <td className="py-1 pr-3">{a.httpStatus ?? "—"}</td>
                        <td className="py-1 pr-3 font-mono text-xs">
                          {a.n8nExecutionId ?? "—"}
                        </td>
                        <td className="py-1 pr-3 text-red-800">
                          {a.error ?? ""}
                        </td>
                        <td className="whitespace-nowrap py-1 pr-3 text-slate-500">
                          {when(a.startedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </Section>

      <Section title="Timeline">
        <ol className="space-y-2">
          {events.map((e) => (
            <li
              key={e.id}
              className="rounded-md border border-slate-100 p-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{label(e.type)}</span>
                <span className="text-xs text-slate-500">
                  {e.actor} · {when(e.createdAt)}
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
