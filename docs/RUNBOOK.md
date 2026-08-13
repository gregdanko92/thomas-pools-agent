# Thomas Pools Agent — Operations Runbook

## What the agent does

A Node.js/TypeScript service running on Railway that automates project health checks, vendor communication, calendar sync, and payment tracking for Thomas Pools.

| Feature | Schedule | Slack channel |
|---|---|---|
| Morning health check | Daily 7 AM PT | `SLACK_MORNING_CHANNEL` |
| Evening leadership report | Daily 5 PM PT | `SLACK_EVENING_CHANNEL` |
| Google Calendar sync | Hourly | — |
| Payment reminders | Daily 8 AM PT | `SLACK_PAYMENT_CHANNEL` |
| Vendor SMS outreach | Daily 9 AM PT | — (SMS to vendors) |
| `/jobstatus [name]` slash command | On demand | Same channel as command |
| Error alerts | On any cron failure | `SLACK_ERROR_CHANNEL` |

---

## Railway dashboard

**URL:** https://railway.app — open the `thomas-pools-agent` project.

- **Logs:** click the service → Deployments → active deploy → View Logs
- **Env vars:** click the service → Variables
- **Redeploy:** click the service → Deployments → Redeploy (or push to `main`)

The service auto-deploys on every push to `main`. If Railway doesn't pick up a push within a few minutes, use the "Check for updates" button in the deployment panel.

---

## Manual triggers

All cron jobs can be fired on-demand via HTTP without waiting for the schedule. Replace `<secret>` with `CRON_SECRET` from Railway (omit the header if `CRON_SECRET` is not set).

```bash
BASE=https://thomas-pools-agent-production.up.railway.app

# Morning health check
curl -X POST $BASE/cron/morning -H "x-cron-secret: <secret>"

# Evening report
curl -X POST $BASE/cron/evening -H "x-cron-secret: <secret>"

# Google Calendar sync
curl -X POST $BASE/cron/calendar-sync -H "x-cron-secret: <secret>"

# Payment reminders
curl -X POST $BASE/cron/payment-reminders -H "x-cron-secret: <secret>"

# Vendor outreach
curl -X POST $BASE/cron/vendor-outreach -H "x-cron-secret: <secret>"

# Health check
curl $BASE/health
```

All cron endpoints return `{"triggered":true}` immediately (202 Accepted) and run the job in the background. Check Railway logs or the relevant Slack channel to confirm completion.

---

## Monitoring

### Normal operation signals
- Morning health check posts to Slack by 7:05 AM PT every day.
- Evening report posts to Slack by 5:05 PM PT every day.
- Google Calendar events appear/update within 1 hour of a Jobtread task change.
- `agent_run_log` table in Supabase records every run with `success: true`.

### Alert signals
- Any message in `#agent-errors` (or your `SLACK_ERROR_CHANNEL`) means a cron job threw an unhandled error.
- `agent_run_log` rows with `success: false` contain the `error_message`.

### Supabase queries for quick diagnosis

```sql
-- Last 20 runs, newest first
SELECT run_type, success, error_message, created_at
FROM agent_run_log
ORDER BY created_at DESC
LIMIT 20;

-- Failed runs in the last 24 hours
SELECT * FROM agent_run_log
WHERE success = false AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;

-- Current cron lock state
SELECT * FROM cron_locks;

-- SMS outreach log
SELECT v.name, o.status, o.sent_at, o.twilio_message_sid
FROM outreach_log o
JOIN vendors v ON v.id = o.vendor_id
ORDER BY o.sent_at DESC
LIMIT 50;
```

---

## Common issues and resolutions

### Agent is not posting morning/evening reports

1. Check Railway logs for the 7 AM / 5 PM run.
2. Check `#agent-errors` for an error alert.
3. Query `agent_run_log` for a recent `morning_check` / `evening_report` row with `success: false`.
4. Common causes:
   - `JOBTREAD_GRANT_KEY` expired — see key rotation below.
   - `SLACK_BOT_TOKEN` revoked — regenerate in api.slack.com/apps.
   - Claude API outage — check status.anthropic.com; the agent will retry 3× automatically.

### Cron lock stuck (job shows "already running" but isn't)

The distributed lock has a 30-minute stale timeout. If a Railway deployment crashed mid-run, the lock row in `cron_locks` stays held until it ages out.

First, check what lock names are actually held:

```sql
SELECT * FROM cron_locks;
```

Then clear the specific stuck lock using the `lock_name` value from that query:

```sql
-- Lock names used by this agent:
-- morning-health-check | evening-report | calendar-sync | payment-reminders | vendor-outreach
UPDATE cron_locks SET released_at = now() WHERE lock_name = 'morning-health-check';
```

Or delete all locks and let them re-acquire naturally on the next run:

```sql
DELETE FROM cron_locks;
```

### Google Calendar events not appearing

1. Verify `GOOGLE_CALENDAR_ID` in Railway is the correct calendar ID (from Google Calendar → Settings → Integrate calendar).
2. Verify the service account email (`GOOGLE_CLIENT_EMAIL`) has **"Make changes to events"** permission on that calendar.
3. Check Railway logs for `[calendar-sync] created=0 updated=0 errors=N` to confirm errors.
4. Common cause: `GOOGLE_PRIVATE_KEY` in Railway needs literal `\n` sequences (copy exactly from the JSON key file — do not convert newlines).

### Vendor SMS not sending

1. Confirm `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_FROM_NUMBER` are all set in Railway.
2. Confirm the Twilio number is approved for A2P 10DLC messaging (US SMS compliance).
3. Check `outreach_log` for `status = 'failed'` rows with no `twilio_message_sid`.
4. If `VENDOR_OUTREACH_TEST_PHONE` is set, ALL outbound SMS go to that number — remove it when ready for live sending.

### Payment reminders not alerting

1. Confirm `SLACK_PAYMENT_CHANNEL` is set in Railway.
2. Confirm the Slack bot is invited to that channel (`/invite @thomas-pools-agent`).
3. Confirm `payment_schedules` table has rows with `collected = false`.
4. Check that `notified_at` is not blocking re-notification — milestones re-alert after 7 days.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (full DB access) |
| `JOBTREAD_GRANT_KEY` | Yes | Jobtread Pave API grant key |
| `JOBTREAD_ORG_ID` | Yes | Jobtread organization ID (e.g. `22PAqEZPfsja`) |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Yes | Slack app-level token for Socket Mode (`xapp-…`) |
| `SLACK_MORNING_CHANNEL` | Yes | Channel ID for morning health check posts |
| `SLACK_EVENING_CHANNEL` | Yes | Channel ID for evening leadership report posts |
| `SLACK_PAYMENT_CHANNEL` | Yes | Channel ID for payment reminder alerts |
| `SLACK_ERROR_CHANNEL` | Yes | Channel ID for agent error alerts (private to operator) |
| `GOOGLE_CLIENT_EMAIL` | Yes | Service account email for Google Calendar |
| `GOOGLE_PRIVATE_KEY` | Yes | Service account private key (literal `\n` sequences) |
| `GOOGLE_CALENDAR_ID` | Yes | Google Calendar ID to sync Jobtread tasks into |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_API_KEY_SID` | Yes | Twilio API key SID |
| `TWILIO_API_KEY_SECRET` | Yes | Twilio API key secret |
| `TWILIO_AUTH_TOKEN` | Conditional | Twilio auth token — required only for inbound webhook signature validation; outbound SMS works without it |
| `TWILIO_FROM_NUMBER` | Yes | Outbound SMS number in E.164 format (`+1…`) |
| `HUBSPOT_ACCESS_TOKEN` | No | HubSpot Personal Access Key (integration built, not wired to active crons) |
| `CRON_SECRET` | No | Optional shared secret for manual HTTP trigger endpoints |
| `PORT` | No | HTTP port (Railway sets this automatically) |
| `VENDOR_OUTREACH_TEST_PHONE` | No | If set, ALL outbound SMS are redirected to this number (safe testing) |
| `VENDOR_OUTREACH_INTERVAL_DAYS` | No | Days between vendor outreach attempts (default: 3) |
