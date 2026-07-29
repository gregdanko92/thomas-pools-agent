# Thomas Pools Plan

## Thomas Pools AI Agent — Build Tasks

### Phase 1 — Foundation
1. Create GitHub repo and Railway project, link them
2. Initialize TypeScript/Node.js project with Fastify — `package.json`, `tsconfig.json`, folder structure
3. Set up Supabase project and run schema migrations (6 tables)
4. Configure environment variables across Railway and local `.env`
5. Deploy skeleton server to Railway with `/health` endpoint — confirm it stays up

### Phase 2 — Integration Clients
6. Build Jobtread API client (Pave query wrapper, typed helpers for jobs/tasks/documents/comments)
7. Build Slack bot client (install bot to Thomas Pools workspace, Socket Mode setup)
8. Build Twilio client (outbound SMS + inbound webhook receiver)
9. Build Claude API client (prompt wrapper, retry logic)
10. Build Google Calendar client (OAuth setup, create/update event helpers)
11. Build HubSpot client (read customer contacts and payment data)

### Phase 3 — Read-Only Cases (lowest risk, validates the pipeline)
12. **Case 5:** `/status [job name]` slash command — Jobtread read → Claude summarize → Slack reply
13. **Case 1:** Morning health check cron (7 AM) — per-PM Slack summaries
14. **Case 6:** Evening leadership report cron (5 PM) — aggregate and post to `#daily-report`

### Phase 4 — Write Cases
15. **Case 2:** Vendor outreach — cron fires, checks outreach log, sends SMS via Twilio, logs in Supabase
16. **Case 2 inbound:** Twilio webhook receives vendor reply, logs it, alerts PM in Slack if flagged
17. **Case 2 follow-up:** 24-hour re-ping and 48-hour PM escalation logic
18. **Case 3:** Slack project channel listener — Claude extracts update → writes comment to Jobtread → confirms in channel

### Phase 5 — Remaining Cases
19. **Case 4:** Google Calendar sync — detect new/changed Jobtread milestones, create/update calendar events
20. **Case 7:** Payment milestone reminders — cross-reference Jobtread documents against payment schedule, Slack alerts

### Phase 6 — Hardening
21. Error alerting to `#agent-errors` Slack channel
22. Idempotency guards (prevent duplicate SMS, duplicate calendar events, duplicate alerts)
23. Retry logic on Jobtread/Twilio/Slack API failures
24. Populate Supabase with Thomas Pools' real vendor roster and payment schedules
25. End-to-end test run on live data with Thomas Pools team
26. Hand off grant key rotation schedule and monitoring runbook
