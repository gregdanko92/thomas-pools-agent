# PM Check-In Logic

Every weekday at 4 PM PT, the agent runs a check-in pass across all active jobs. For each job, it decides whether to send a new check-in message, nudge an unanswered thread, or stay quiet.

---

## When check-ins fire

The agent runs through four rules in order for every active job. The first rule that matches determines the outcome.

### Rule 1 — Open thread from today → skip

If a check-in was already sent today and the PM hasn't answered yet, don't send another one. The thread is still open.

### Rule 2 — Open thread from a previous day → nudge

If a check-in was sent on a prior day and the PM still hasn't answered, post a follow-up in the **existing thread**:

> "Just following up — any update on the **Excavation** stage for **Smith Residence**?"

The thread stays open. If the PM replies to the nudge, the same reply handler processes it as if they had answered the original message.

### Rule 3 — Stage deadline more than 5 days out → skip

The agent only checks in when a stage is getting close. If the earliest task end date for the current stage is more than 5 calendar days away, nothing is sent. The job will be picked up again on a future day when it enters the window.

### Rule 4 — Cooldown (2 days) → skip, unless deadline eve

If the PM already answered a check-in for this job within the last 2 days (either confirmed or reported a delay), don't ask again — **unless today is deadline eve** (see below).

**Deadline eve override:** The day before a stage is due, the agent always sends a check-in regardless of cooldown. This is a hard rule.

### All rules passed → send a fresh check-in

A new message is posted in the job's Slack channel, tagging the PM:

> "@Reagan, for the **Smith Residence** job you're currently at **Excavation** from 2026-08-18 – 2026-08-22. Next up is Steel. Is everything on track and are we ready for the next stage?"

---

## Deadline eve and weekends

"Deadline eve" is defined as the **last business day before the stage deadline**, not simply the calendar day before. This matters for deadlines that fall on or near weekends:

| Stage end date | Deadline eve |
|---|---|
| Tuesday | Monday |
| Monday | Friday |
| Saturday | Friday |
| Sunday | Friday |

The deadline day itself also counts as "eve" — if the cron runs on the day a stage is due, the cooldown bypass still applies.

---

## What happens when a PM replies

**Confirmed (on track):**
The thread closes. No further check-ins for 2 days (cooldown), then normal window logic resumes.

**Delayed with a new date:**
1. The agent shifts all future Jobtread Gantt tasks forward by the number of days between the originally scheduled end date and the new date.
2. Google Calendar events for those tasks are updated automatically.
3. The agent replies in thread: *"Got it — new expected completion: 2026-09-05. Shifted 4 Gantt tasks by 8 days."*
4. Thread closes. The 2-day cooldown applies, but deadline eve for the **new** end date will override it when the time comes.

**Delayed with no date:**
The agent asks for a reschedule date:
> "Got it — what's the new target date for the Excavation stage?"

The thread stays open (same as clarification). When the PM provides a date, it's treated as a delayed-with-date reply and the Gantt is shifted.

**Ambiguous reply:**
The agent asks a follow-up question to clarify. Thread stays open.

---

## Example week — stage due Thursday

| Day | What happens |
|---|---|
| Mon | Stage ends in 8 days → outside 5-day window → skip |
| Tue | Stage ends in 6 days → outside window → skip |
| Wed | Stage ends in 5 days → enters window → **send check-in** |
| Wed PM | PM replies "on track" → thread confirmed, cooldown starts |
| Thu | Within cooldown (1 day since confirmed) → skip |
| Thu | *(deadline eve override doesn't apply — tomorrow is the deadline)* |
| **Wed is deadline eve** | Cooldown bypassed → **send check-in** |

Wait — let me redo with a cleaner example:

| Day | Stage ends | daysUntilEnd | Action |
|---|---|---|---|
| Mon | Thu | 3 | In window, no prior check-in → **send** |
| Mon PM | | | PM confirms |
| Tue | Thu | 2 | Cooldown (confirmed yesterday) → skip |
| **Wed** | **Thu** | **1** | **Deadline eve → bypass cooldown → send** |
| Wed PM | | | PM confirms again |
| Thu | | 0 | Deadline day (also counts as eve) → bypass cooldown → send if needed |

---

## Example — PM reports delay on Wednesday

Stage was due Thursday. PM replies Wednesday "we'll be done next Tuesday."

1. Agent shifts Gantt: tasks moved forward 5 days. New end date: Tuesday.
2. Thread closes, cooldown starts.
3. **Monday** (next week): deadline eve for Tuesday → cooldown bypassed → **send check-in**.
4. PM confirms Monday → done.

---

## Constants (adjustable in `src/cron/pmCheckin.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `LOOKAHEAD_DAYS` | 5 | How many days before the end date to start checking in |
| `COOLDOWN_DAYS` | 2 | How many days to wait after a resolved check-in before asking again |
| Cron schedule | `0 16 * * 1-5` | 4 PM PT, Mon–Fri only |
