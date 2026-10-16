# Background processing via a Postgres job table and a worker process

Submitting a Request inserts the Ticket and a queued job in one transaction and returns immediately; a separate worker process (same codebase) claims jobs with `FOR UPDATE SKIP LOCKED` and runs classification, then Dispatch. We rejected doing this inline in the HTTP request (a crash mid-way strands the Ticket with nothing to resume it, and a slow model blocks the form) and rejected adding a queue product such as Redis/BullMQ (one more service to run and explain, when Postgres already gives transactional enqueueing).
