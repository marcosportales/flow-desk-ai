// Who a Ticket Event is attributed to: a signed-in User, an Integration using
// the API key, or the system (AI, Priority Rules, Dispatch, workers).
export type Actor =
  | { kind: "system" }
  | { kind: "integration" }
  | { kind: "user"; userId: string };

export const systemActor: Actor = { kind: "system" };
export const integrationActor: Actor = { kind: "integration" };
export const userActor = (userId: string): Actor => ({ kind: "user", userId });

// The `actor` and `actor_user_id` columns of a Ticket Event.
export function actorColumns(actor: Actor) {
  return actor.kind === "user"
    ? ({ actor: "user", actorUserId: actor.userId } as const)
    : ({ actor: actor.kind, actorUserId: null } as const);
}
