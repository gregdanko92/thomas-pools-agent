# GRE-31 Testing Plan — Test Job Only

All tests use **test job `22PcxVVzRLCk`** exclusively. No real jobs are touched.

**Prerequisites (set in Railway env vars before running):**
```
SLACK_TEST_MODE=true
SLACK_TEST_USER_ID=U0BJXKM8TM0
```

**Trigger command** (replace `<SECRET>` with Railway `CRON_SECRET` value):
```sh
curl -s -X POST https://thomas-pools-agent-production.up.railway.app/cron/pm-checkin \
  -H "x-cron-secret: <SECRET>"
```

**Setup script** (resets state, adjusts task dates, inserts fake rows for scheduling scenarios):
```sh
npx tsx scripts/test-gre31-setup.ts                     # print current state
npx tsx scripts/test-gre31-setup.ts --reset              # delete all test threads
npx tsx scripts/test-gre31-setup.ts --shift-dates 3      # set task end dates to today+3
npx tsx scripts/test-gre31-setup.ts --fake-cooldown      # insert fake confirmed row (simulates cooldown)
npx tsx scripts/test-gre31-setup.ts --fake-yesterday     # backdate pending thread (triggers nudge)
```

**Reset between tests:**
```sql
DELETE FROM pm_checkin_threads WHERE jobtread_job_id = '22PcxVVzRLCk';
```

---

## Task Setup

The test job currently has no tasks. **The Jobtread Pave API `createTask` requires an undocumented "task target" entity that we haven't been able to resolve via the API, so tasks must be created manually in the Jobtread UI.**

Create these two tasks on the test job before running Gantt-shift or lookahead scenarios:

| Task name | Notes |
|---|---|
| `Engineering Plan` | Name must contain "engineering" to match the stage keyword |
| `Permit Application` | Name must contain "permit" to match the stage keyword |

Once tasks exist, use `--shift-dates <N>` to move their end dates for each scenario.

**Scenarios 1–4 and 7–8 do NOT require tasks** — the check-in fires even with no tasks (null daysUntilEnd bypasses the lookahead skip).

---

## Scenario 1 — Fresh check-in fires (baseline)

**Goal:** Verify a check-in message is sent when the test job has tasks inside the 5-day window and no prior threads.

**Setup:**
1. Confirm `pm_checkin_threads` has no rows for `22PcxVVzRLCk` (run `--status` or check Supabase)
2. If tasks exist on the test job, optionally run `--shift-dates 3` so they have a date range to show in the message

**Trigger:** Fire the cron with curl

**Verify in Slack (Greg's DM):**
- Message contains `[TEST MODE — Intended Target: Mark in #C0BR66MCB5Y]`
- Contains `Engineering / Permitting` stage name
- Contains the date range from the tasks
- Contains "Next up is Excavation"

**Verify in Supabase:**
```sql
SELECT thread_ts, status, checkin_date, checkin_stage
FROM pm_checkin_threads WHERE jobtread_job_id = '22PcxVVzRLCk';
```
- One row, `status = 'pending'`, `checkin_date = today`, `checkin_stage = 'Engineering / Permitting'`

---

## Scenario 2 — Duplicate guard (same day)

**Goal:** Verify a second trigger on the same day produces no second message.

**Setup:** Run immediately after Scenario 1 (thread still pending from today)

**Trigger:** Fire the cron again

**Verify:**
- No new Slack message appears
- Supabase still has exactly 1 row for the test job
- Railway logs show `skipped: ["Test Job — pending thread from today"]`

---

## Scenario 3 — PM confirms (on track)

**Goal:** Verify `confirmed` reply closes the thread.

**Setup:** Start from the pending thread created in Scenario 1 (or re-run Scenario 1 after a reset)

**Action:** In Greg's Slack DM, reply to the check-in thread:
> "Yes everything looks good, on track"

**Verify in Slack:** Bot replies in the same thread with a confirmation summary.

**Verify in Supabase:**
```sql
SELECT status, conversation_history FROM pm_checkin_threads WHERE jobtread_job_id = '22PcxVVzRLCk';
```
- `status = 'confirmed'`
- `conversation_history` has 3 entries: agent check-in, PM reply, agent summary

---

## Scenario 4 — Cooldown prevents re-check (after confirm)

**Goal:** Verify the 2-day cooldown blocks a new check-in after confirming.

**Setup:** Leave the `confirmed` row from Scenario 3 in place (do NOT reset)

**Trigger:** Fire the cron

**Verify:**
- No new Slack message
- Railway logs show `skipped: ["Test Job — resolved within last 2 days"]`

---

## Scenario 5 — Delayed with date → Gantt shift

**Goal:** Verify a delay reply with a date shifts Jobtread task dates.

**Setup:**
1. Create tasks in Jobtread UI if not already present (`Engineering Plan`, `Permit Application`)
2. Run `npx tsx scripts/test-gre31-setup.ts --reset` then `--shift-dates 3`
3. Note the current end dates shown in the script output
4. Fire the cron → receive check-in in Slack DM

**Action:** Reply in the Slack thread:
> "We're running behind, should be done by [today+10 in YYYY-MM-DD format]"

**Verify in Slack:** Bot replies in thread:
```
Got it — new expected completion: YYYY-MM-DD. Shifted 2 Gantt tasks by 7 days.
```
(Task count = 2 if both tasks were created, delta = 10 - 3 = 7)

**Verify in Jobtread:**
- Open test job → Gantt view
- Both task end dates shifted forward by 7 days from their original values
- Start dates also shifted (since they're `>= today`)

**Verify in Supabase:**
```sql
SELECT status FROM pm_checkin_threads WHERE jobtread_job_id = '22PcxVVzRLCk';
```
- `status = 'delayed'`

> **Note on calendar events:** The test job won't have rows in `calendar_sync` unless you've run the morning health check and it synced the test job's tasks. `shiftedEvents` will be 0, which is expected. If you want to test calendar sync, manually insert a row in `calendar_sync` pointing a test task ID to a real (test) Google Calendar event.

---

## Scenario 6 — Delayed, no date → bot asks → PM provides date → Gantt shifts

**Goal:** Verify the two-step delay flow: agent asks for reschedule date, then shifts when PM provides it.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset` then `--shift-dates 3`
2. Fire cron → receive check-in

**Action (step 1):** Reply in thread:
> "We're behind on this"

**Verify:** Bot replies:
```
Got it — what's the new target date for the Engineering / Permitting stage?
```
Supabase: `status` still `'pending'`

**Action (step 2):** Reply in the same thread:
> "Probably [today+8 as YYYY-MM-DD]"

**Verify in Slack:** Bot replies with shift confirmation: `Shifted 2 Gantt tasks by 5 days.`

**Verify in Jobtread:** Task end dates advanced by 5 days.

**Verify in Supabase:** `status = 'delayed'`

---

## Scenario 7 — Ambiguous reply → clarification

**Goal:** Verify Claude asks a follow-up question for unclear replies.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset`
2. Fire cron

**Action:** Reply:
> "maybe"

**Verify:** Bot asks a follow-up like:
```
Could you clarify — is the current stage on track or is there a delay?
```

**Verify in Supabase:** `status = 'pending'` (thread still open), `conversation_history` has 3 entries.

**Follow-up:** Reply "yes on track" → verify `status` becomes `confirmed`.

---

## Scenario 8 — 24h nudge (unanswered thread)

**Goal:** Verify that an open thread from a previous day gets a nudge, not a new check-in.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset`
2. Fire cron → creates pending thread for today
3. Backdate it:
```sh
npx tsx scripts/test-gre31-setup.ts --fake-yesterday
```

**Trigger:** Fire cron again

**Verify in Slack:** A new message appears **in the same thread** (not a top-level DM):
```
Just following up — any update on the *Engineering / Permitting* stage for *Test Job*?
```

**Verify in Supabase:** Still one row, `status = 'pending'` (nudge doesn't open a new row)

---

## Scenario 9 — Outside lookahead window (skip)

**Goal:** Verify jobs with deadlines >5 days out are skipped.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset`
2. In Jobtread UI, set both task end dates to `today+8` — or run `--shift-dates 8` if tasks exist

**Trigger:** Fire cron

**Verify:** No Slack message. Railway logs show:
```
skipped: ["Test Job — stage ends in 8 days (outside 5-day window)"]
```

---

## Scenario 10 — Deadline eve bypasses cooldown

**Goal:** Verify that `isDeadlineEve` fires even when cooldown is active.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset`
2. Set task end dates to tomorrow: `--shift-dates 1`
3. Insert fake cooldown row: `npx tsx scripts/test-gre31-setup.ts --fake-cooldown`

**Trigger:** Fire cron

**Verify:** Check-in fires despite cooldown — bot sends the message in Slack.

**Why it fires:** `endDate = tomorrow` → `daysUntilEnd = 1` → `isDeadlineEve = true` → cooldown bypassed.

> **Weekend test variant:** Set `endDate = next Monday` and run on Friday. Verify `isDeadlineEve` returns true (Friday is eve for Monday deadline). This requires manually adjusting your system date or the task end date.

---

## Scenario 11 — No tasks for stage (no check-in)

**Goal:** Verify no check-in fires when the test job has no tasks matching stage keywords.

**Setup:**
1. `npx tsx scripts/test-gre31-setup.ts --reset`
2. Ensure the test job has NO tasks in Jobtread (delete via the Jobtread UI if any exist)

**Trigger:** Fire cron

**Verify:** No Slack message. The test job passes the lookahead check (because `daysUntilEnd` is null, which doesn't trigger the skip) but `findStageTasks` returns empty, so `dateRange` is null and the check-in fires with no date info.

> Actually — with `daysUntilEnd = null`, the lookahead skip condition is `daysUntilEnd !== null && daysUntilEnd > LOOKAHEAD_DAYS`, which is false. The job proceeds to send. So this scenario actually tests that a check-in goes out with no date range text. Verify the Slack message omits the date range but still fires.

---

## Cleanup After Testing

```sh
npx tsx scripts/test-gre31-setup.ts --reset
```

Delete the test tasks in Jobtread via the Jobtread UI when done.

---

## Quick Reference

**Script shortcuts:**
```sh
npx tsx scripts/test-gre31-setup.ts                 # print state
npx tsx scripts/test-gre31-setup.ts --reset          # delete test threads
npx tsx scripts/test-gre31-setup.ts --shift-dates 3  # today+3 end date
npx tsx scripts/test-gre31-setup.ts --shift-dates 8  # today+8 (outside window)
npx tsx scripts/test-gre31-setup.ts --shift-dates 1  # tomorrow (deadline eve)
npx tsx scripts/test-gre31-setup.ts --fake-cooldown  # active cooldown row
npx tsx scripts/test-gre31-setup.ts --fake-yesterday # backdate pending → nudge
```

**Supabase queries (for deeper inspection):**
```sql
-- Thread state
SELECT thread_ts, status, checkin_date, checkin_stage, conversation_history
FROM pm_checkin_threads WHERE jobtread_job_id = '22PcxVVzRLCk' ORDER BY created_at DESC;

-- Calendar sync rows for test tasks (paste task IDs from script output)
SELECT * FROM calendar_sync WHERE jobtread_task_id IN ('task-id-1', 'task-id-2');

-- Last 3 cron run logs
SELECT details, created_at FROM agent_run_log
WHERE run_type = 'pm_checkin' ORDER BY created_at DESC LIMIT 3;

-- PM reply log
SELECT details, created_at FROM agent_run_log
WHERE run_type = 'pm_checkin_reply' ORDER BY created_at DESC LIMIT 3;
```
