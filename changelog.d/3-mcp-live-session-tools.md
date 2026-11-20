---
section: Added
---
MCP live-session tools for a coach that drives a workout: `get_session_state`
(current exercise, next set targets, form cue, rest countdown), `start_session`,
`log_set`, `log_set_from_text` (keeps the trainee's words as the set note),
`edit_last_set`, `delete_last_set` and `finish_session`. They reuse the
session runner's target logic and the REST routes' write service (#3).
