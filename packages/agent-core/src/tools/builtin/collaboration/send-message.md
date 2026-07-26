Send a message to another teammate in your expert team.

Your plain-text output is NOT visible to your teammates. Sending a message is
the ONLY way to hand a result, ask a question, or coordinate. The team uses a
star topology: every member talks to `team-lead`; only the lead assigns and
follows up on member work.

Message types:
- `message`: a direct message to one teammate. Set `recipient` (use
  `"team-lead"` to reach the lead) and `message`.
- `broadcast`: send `message` to every teammate except yourself.
- `shutdown_request` (lead only): ask a member to finish and stop. Set
  `recipient`. The member is force-stopped if it does not respond in time.
- `shutdown_response` (member): answer a shutdown request. Set `request_id`
  (from the request you received) and `approve`. Send your complete final
  results to `team-lead` BEFORE approving.

Rules:
- Members: before you stop, send your complete professional deliverable to
  `team-lead` with `type="message"`. The `message` body must be the full
  result — do not summarize-and-trail-off.
- The lead assigns a member's first task with the Agent tool, then uses
  SendMessage to follow up. Do not spawn the same member twice.
- `summary` is a short one-line header shown to the recipient; `message` is the
  full body.
