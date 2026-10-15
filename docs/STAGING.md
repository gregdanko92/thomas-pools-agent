# Staging Environment

Staging is a second deployment of the agent for testing features before they reach
production. It has its own database and its own Slack app, and can only touch the
Jobtread test job. Nothing needs to be toggled in production to test, and nothing in
production needs cleaning up afterwards.

## What staging can and can't do

| System | Staging behavior |
|---|---|
| **Supabase** | Separate staging project. Wipe it any time with `npm run staging:reset-db`. |
| **Slack** | Separate "Thomas Pools Agent (Staging)" app. Every post is forced to `SLACK_TEST_CHANNEL_ID`. Posts elsewhere throw. Check-ins and nudges carry a `[TEST MODE — Intended Target: …]` header. The slash command is `/jobstatus-staging`. |
| **Jobtread** | Same org. Reads and writes are limited to `JOBTREAD_ALLOWED_JOB_IDS` (the test job). With `JOBTREAD_STAGING_READ_ALL=true`, reads see every real job but writes stay limited to the test job. |
| **Google Calendar** | Separate test calendar. Calendar sync only writes events for allowlisted jobs, even with read-all on. |
| **Crons** | Off. Trigger them with `npm run staging:trigger -- <name>`. Set `CRONS_ENABLED=true` to turn the schedules on. |
| **Twilio** | Refuses to send unless `VENDOR_OUTREACH_TEST_PHONE` is set. |
| **Channel sync** | Maps channels in the staging DB but never joins real job channels. |

### Startup safety check

On boot the agent checks its own config and refuses to start if it doesn't match `APP_ENV`:

- **Staging** must not hold the production Supabase URL or the production Slack app (`A0BMC4CFZUK`). It must have `JOBTREAD_ALLOWED_JOB_IDS` and `SLACK_TEST_CHANNEL_ID` set.
- **Production** (the default when `APP_ENV` is unset) must hold the production Supabase URL and Slack app. A staging service that forgets `APP_ENV=staging` therefore fails to start instead of acting like production.

The production fingerprints live in `src/lib/env.ts`.

## One-time setup

### 1. Staging Supabase project
1. Create a new Supabase project, e.g. `thomas-pools-staging`.
2. Copy the production schema into it. Don't use `supabase/schema.sql`: it's out of date (for example, `pm_checkin_threads` is missing the `jobtread_task_id` and `task_name` columns the code writes). Dump the live schema instead:
   ```
   pg_dump "<prod session pooler string>" --schema-only --schema=public --no-owner --no-privileges > /tmp/prod-schema.sql
   psql "<staging session pooler string>" -f /tmp/prod-schema.sql
   ```
   Get each connection string from the project's **Connect** button in the Supabase dashboard (Session pooler), and fill in the database password. This is not the service role key; reset it under Project Settings → Database if it's unknown. An error saying `schema "public" already exists` during the load is expected. `supabase db dump` would also work, but it needs Docker.
   Afterwards, overwrite `supabase/schema.sql` with the dump so the repo matches production again.
3. Note the staging project URL and service role key.

### 2. Staging Slack app
1. Go to api.slack.com/apps → **Create New App**. Either duplicate the production app's manifest (Settings → App Manifest on `A0BMC4CFZUK`) or create one from scratch.
2. Name it **Thomas Pools Agent (Staging)**.
3. Enable **Socket Mode**. Generate an app-level token with `connections:write` (this becomes `SLACK_APP_TOKEN`).
4. Give it the same bot scopes as production. Make sure `users:read` is included, because the startup check needs it.
5. Rename the slash command to **`/jobstatus-staging`**.
6. Subscribe to the same bot events as production (message events).
7. Install it to the workspace and copy the bot token (`SLACK_BOT_TOKEN`).
8. Create `#tpagent-staging-test` if needed and invite **only** the staging bot. Copy the channel ID into `SLACK_TEST_CHANNEL_ID` and all the `SLACK_*_CHANNEL` settings.

> Staging must never use the production Slack tokens. Socket Mode splits events between every connection on the same app token, so production would randomly miss PM replies. The startup check blocks this.

### 3. Test Google Calendar
1. Create a calendar such as "Thomas Pools — Staging".
2. Share it with the service account (`GOOGLE_CLIENT_EMAIL`) with "Make changes to events".
3. Use its calendar ID as `GOOGLE_CALENDAR_ID` in staging.

### 4. Railway staging environment
1. In the Railway project: **Environments → New Environment → `staging`**. Start it empty rather than duplicating production, so no production variables carry over.
2. Point the service at the GitHub branch **`staging`**, with auto-deploy on.
3. Set the variables listed in `.env.staging.example`.
4. Generate a public domain for the staging service. This becomes `STAGING_URL`.
5. Create the branch: `git push origin main:staging`.

### 5. Local `.env.staging`
Copy `.env.staging.example` to `.env.staging` (it's gitignored) and fill in the same values as Railway staging. The `staging:*` scripts read it, and they refuse to run if it isn't a genuine staging config.

### 6. Seed staging
```
npm run staging:reset-db     # maps the test job to #tpagent-staging-test in the staging DB
npm run staging:save-job     # records the test job's task dates as the reset baseline
```

### 7. Production cleanup
In Railway production, delete `SLACK_TEST_MODE` and `SLACK_TEST_CHANNEL_ID`. They're no longer read, because test mode is now tied to `APP_ENV=staging`. You can optionally set `APP_ENV=production` explicitly.

## Testing a feature

1. **Push the branch and open a PR as usual.**
   ```
   git push -u origin feat/my-feature
   ```
2. **Deploy it to staging.** The `staging` branch is just a pointer to whatever is under test.
   ```
   git push origin feat/my-feature:staging --force
   ```
   Railway's staging environment redeploys in about a minute. Production is untouched.
3. **Trigger it.**
   - Cron features: `npm run staging:trigger -- pm-checkin` (or `morning`, `evening`, `schedule-nudge`, `calendar-sync`, `channel-sync`, `payment-reminders`, `vendor-outreach`).
   - Slack features: interact in `#tpagent-staging-test`. For example, reply in a check-in thread, or run `/jobstatus-staging`.
4. **Check the results.**
   - `#tpagent-staging-test` for messages
   - The test job in Jobtread for task date changes and comments
   - The staging Supabase table editor for rows
   - Railway staging logs. A `[staging guard]` error means the code tried to touch something real and was blocked.
5. **Iterate.** Fix on the feature branch, push, then re-run step 2.
6. **Reset when leftover state gets in the way** (not after every test):
   ```
   npm run staging:reset-db     # wipe staging DB, re-seed the test job mapping
   npm run staging:reset-job    # put the test job's task dates back to the baseline
   ```
7. **Ship.** Merge the PR to `main`. Production deploys, and you watch the next real run in the production logs.

### Previewing reports with real data
Set `JOBTREAD_STAGING_READ_ALL=true` in Railway staging, then trigger `morning` or `evening`. The report covers every real job but lands only in `#tpagent-staging-test`. Turn it back off afterwards to keep staging quiet and light on Jobtread API calls.

### Schema changes
If a feature adds a table or column, apply the migration to staging Supabase before step 2. Apply it to production right before merging in step 7.

### Running locally
`npm run dev:staging` runs the agent on your machine with `.env.staging`. Pause the Railway staging service first: two Socket Mode connections on the staging app would split Slack events between them.
