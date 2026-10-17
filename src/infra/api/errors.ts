// Uniform error shape for the public API: IMPLEMENTATION.md §7.
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}
