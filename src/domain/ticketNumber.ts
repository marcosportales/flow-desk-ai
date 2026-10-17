// A Ticket's number as people see it: 42 → "FD-0042".
export function formatTicketNumber(number: number): string {
  return `FD-${String(number).padStart(4, "0")}`;
}
