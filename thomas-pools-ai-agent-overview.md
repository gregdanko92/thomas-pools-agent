# Thomas Pools AI Agent — System Overview
**Prepared for:** Thomas Pools Leadership Team  
**Version:** 1.0  
**Date:** July 16, 2026

---

## What Is the AI Agent?

The Thomas Pools AI Agent is a software system that monitors your active projects around the clock, communicates with your team and vendors on your behalf, and surfaces the right information to the right people at the right time — without anyone having to remember to ask.

It connects directly to the tools you already use: **Jobtread**, **Slack**, **SMS**, **HubSpot**, and **Google Calendar**. It reads from them, writes to them, and keeps everything in sync.

The sections below describe every scenario the agent handles and exactly what it does in each case.

---

## Case 1: Daily Project Health Check

**When it runs:** Every morning at 7:00 AM

**What triggers it:** A scheduled automatic run — no human action required.

**What the agent does:**
1. Pulls all active projects from Jobtread
2. Compares each project's scheduled task completion dates against today's date
3. Identifies any tasks that are overdue or at risk
4. Checks which tasks were marked complete in the last 24 hours

**What happens next:**
- Each Project Manager receives a Slack message summarizing the status of their projects: what's on track, what's behind, and what needs attention today
- Leadership receives a consolidated report in the `#daily-report` Slack channel covering all active projects

**Example Slack message to a PM:**
> Good morning. Here's your project summary for today:
> 
> **Hendricks Pool — Phase 2 (Gunite)**
> - ✅ Excavation completed yesterday
> - ⚠️ Gunite pour scheduled for today — no confirmation from vendor yet
> - 🔴 Permit inspection is 2 days overdue
> 
> **Rivera Backyard — Phase 1**
> - ✅ All tasks on schedule

---

## Case 2: Vendor & Subcontractor Check-Ins

**When it runs:** On a configurable cadence per project (e.g., every 2 days, or 24 hours before a scheduled task)

**What triggers it:** Scheduled runs tied to each project's task timeline in Jobtread

**What the agent does:**
1. Identifies upcoming tasks in Jobtread that are assigned to a vendor or subcontractor
2. Checks when that vendor was last contacted
3. If no update has been received within the outreach window, sends a text message (SMS) to the vendor

**Example SMS to vendor:**
> Hi Marcus, this is an update request from Thomas Pools. Can you confirm you're still on schedule for the tile work at the Rivera job starting Thursday? Reply here and we'll log it. Thanks.

**What happens when the vendor replies:**
- Their response is captured automatically
- The agent logs the reply as a note in the relevant Jobtread project
- If the vendor flags a delay or issue, the assigned PM is immediately alerted in Slack

**What if there's no reply?**
- After 24 hours with no response, the agent sends a follow-up text
- After 48 hours, the PM is notified in Slack to follow up directly

---

## Case 3: Writing Updates Back to Jobtread

**When it runs:** Whenever a team member posts an update

**What triggers it:** A Project Manager or field team member posts any message in a project's dedicated Slack channel (e.g., `#hendricks-pool`, `#rivera-backyard`). Each project has its own channel — the agent knows which project to update based on which channel the message was posted in.

**What the agent does:**
1. Detects the message in the project channel and maps it to the corresponding Jobtread project automatically
2. Extracts the key details (completion status, notes, photos mentioned, next steps)
3. Writes those details directly into the appropriate fields in Jobtread
4. Confirms back in the same Slack channel what was logged

**Example:**
> PM posts in `#hendricks-pool`: "Gunite pour done today, looks good. Waiting on inspector to schedule."

> Agent replies in `#hendricks-pool`: "Got it. I've updated Jobtread: Gunite marked complete, added note 'Awaiting inspection scheduling.' Want me to add a placeholder task for the inspection follow-up?"

Because each channel maps directly to one project, team members never need to specify which job they're talking about — they just post naturally and the agent handles the rest. This eliminates the need for PMs to update Jobtread manually after posting in Slack.

---

## Case 4: Google Calendar Events

**When it runs:** When a new task or milestone is added to Jobtread, or when a date changes

**What triggers it:** Jobtread project updates (synced automatically)

**What the agent does:**
1. Detects new scheduled milestones or key task dates in Jobtread
2. Creates or updates the corresponding event on the shared Thomas Pools Google Calendar
3. Invites the relevant PM and any assigned vendors if their email is on file

**Calendar events are created for:**
- Project start dates
- Major milestone completions (gunite, plumbing, electrical, tile, plaster, fill)
- Inspections
- Customer walkthroughs
- Subcontractor scheduled visits

---

## Case 5: On-Demand Project Status

**When it runs:** Anytime, on request

**What triggers it:** Any team member types a command in Slack, such as:
> `/status Hendricks Pool`  
> `/status all projects`

**What the agent does:**
1. Queries Jobtread for the latest data on the requested project(s)
2. Pulls any recent vendor replies or team updates
3. Constructs a plain-language status summary and posts it back in Slack within seconds

**Example response:**
> **Hendricks Pool — Current Status**
> Phase: Gunite Complete / Awaiting Plumbing
> Schedule: 1 day behind (plumbing start was Monday, now Thursday)
> Last update: PM noted plumber confirmed for Thursday AM
> Next milestone: Plumbing inspection — scheduled Friday
> Payment status: Deposit collected ✅ | Progress payment #1 due at plumbing rough-in complete

Leadership can use this at any time — before client calls, during meetings, or end of day — without needing to open Jobtread.

---

## Case 6: Daily Leadership Report

**When it runs:** Every evening at 5:00 PM

**What triggers it:** Scheduled automatic run

**What the agent does:**
1. Compiles everything that happened across all active projects that day
2. Pulls task completions, vendor replies, team updates, and any flags from the morning check
3. Formats a concise report and posts it to the `#daily-report` Slack channel

**Report includes:**
- Tasks completed today across all projects
- Tasks that were scheduled for today but not completed
- Vendor confirmations received
- Any issues or delays flagged
- Payment reminders triggered (see Case 7)

---

## Case 7: Payment Milestone Reminders

**When it runs:** Every morning as part of the daily check, and whenever a milestone is marked complete in Jobtread

**What triggers it:** A project milestone is completed in Jobtread, OR a payment due date is approaching based on the contract schedule

**What the agent does:**
1. Cross-references the project's completion milestones in Jobtread against the payment schedule stored in the system
2. When a milestone is marked complete that triggers a payment, it sends a Slack alert to the billing contact
3. Includes the client name, amount owed, and the specific milestone that triggered it

**Example Slack alert:**
> 💰 **Payment Due — Action Required**
> 
> **Client:** Hendricks Family
> **Milestone completed:** Gunite Pour
> **Amount due:** $8,500
> **Per contract:** Progress Payment #2
> 
> HubSpot contact: [link] | Jobtread project: [link]

**Additional payment reminders:**
- If a payment is overdue by more than 3 days, the agent sends a daily reminder until it's marked collected
- Before the next milestone begins on a project with an outstanding payment, the PM is alerted

---

## How the Agent Handles Conflicts and Edge Cases

| Situation | What the Agent Does |
|---|---|
| Vendor doesn't reply to SMS | Follows up once at 24 hours, then alerts PM at 48 hours |
| A PM doesn't respond to a morning Slack alert | Escalates unresolved flags to leadership in the evening report |
| A task is marked complete in Jobtread before the agent checks | Agent picks it up in next run and removes it from overdue list |
| Two milestones complete on the same day | Two separate payment alerts are sent |
| A project is put on hold | PM marks it on hold in Jobtread and agent pauses outreach and reminders for that project |

---

## What the Agent Does NOT Do

- It does not make decisions on your behalf — it surfaces information and sends alerts, but a human approves billing, approves scheduling, and handles conversations that go off-script
- It does not replace your team's judgment — it ensures nothing falls through the cracks
- It does not contact customers directly (in the MVP) — vendor and subcontractor outreach only

---

## Tech Stack

This section covers every piece of infrastructure that powers the agent — where it lives, what it uses, and why.

---

### Hosting — Railway

The agent runs on **Railway** (railway.app), a cloud hosting platform. Railway keeps the agent running 24/7 as a persistent server, which means it can receive incoming messages from Twilio (vendor SMS replies) at any time and respond immediately.

**Why Railway over alternatives:**
- Simpler than AWS or Google Cloud — no DevOps overhead
- Supports always-on servers (unlike Vercel, which is better suited for short-lived functions)
- Built-in cron job scheduling
- Straightforward pricing (~$20–50/month for this workload)

---

### Database — Supabase

**Supabase** is the database layer. It stores everything the agent needs to remember between runs:

| What's stored | Why |
|---|---|
| Vendor contact info mapped to projects | So the agent knows who to text and about which job |
| Outreach log (who was texted, when, did they reply) | Prevents duplicate messages and tracks response rates |
| Payment schedules per project | Cross-referenced against Jobtread milestones for billing alerts |
| Slack channel → Jobtread project mapping | So the agent knows which project to update when a PM posts |
| Daily report archive | Historical record of all reports sent |
| Agent run log | Audit trail of every action the agent took and when |

Supabase uses PostgreSQL under the hood — reliable, queryable, and easy to inspect manually if something needs to be checked or corrected.

---

### Scheduled Jobs (Cron) — Railway Cron

Cron jobs are scheduled tasks that fire automatically at set times. Railway has native cron support built in, so no separate service is needed.

| Job | Schedule |
|---|---|
| Daily project health check + PM Slack summaries | Every day at 7:00 AM |
| Vendor outreach check (who needs a text today?) | Every day at 8:00 AM |
| Payment milestone check | Every day at 8:30 AM |
| Daily leadership report | Every day at 5:00 PM |

All times are configurable and can be adjusted after launch.

---

### AI — Claude API (Anthropic)

The intelligence behind the agent is **Claude**, Anthropic's AI model. Every time the agent needs to read a message and decide what to do — parse a PM's Slack update, summarize a project's status, draft a vendor text — it sends that content to the Claude API and gets a response back.

**Model used:** Claude Sonnet (balances speed and cost for high-frequency tasks)

The agent is not just running scripts — it understands natural language. A PM can write "plaster guys finished up this afternoon, place looks clean" and the agent correctly interprets that as the plastering milestone being complete.

---

### SMS / Text Messaging — Twilio

**Twilio** handles all SMS communication with vendors and subcontractors.

- **Outbound:** The agent calls Twilio's API to send texts
- **Inbound:** When a vendor replies, Twilio forwards that reply to the agent via a webhook (an automatic notification to our server)
- **WhatsApp:** Twilio also supports WhatsApp Business messaging — can be added post-MVP if vendors prefer it

**Estimated cost:** ~$10–20/month at typical Thomas Pools volume (15 active projects, ~4 vendors each, texting 2x per week)

---

### Slack Bot

The agent lives in Thomas Pools' Slack workspace as a bot. It can:
- Post messages to any channel
- Read messages posted in project channels
- Respond to direct slash commands (e.g., `/status Hendricks Pool`)

Setup requires a one-time bot installation by a Slack workspace admin.

---

### Summary

| Layer | Tool | Purpose | Est. Monthly Cost |
|---|---|---|---|
| **Hosting** | Railway | Runs the agent 24/7, handles incoming webhooks | ~$20–50 |
| **Database** | Supabase | Stores vendor data, outreach history, payment schedules, logs | Free tier |
| **Cron Jobs** | Railway Cron | Fires scheduled tasks (morning check, evening report, etc.) | Included in Railway |
| **AI** | Claude API (Anthropic) | Reads and writes natural language, makes decisions | ~$30–80 |
| **SMS** | Twilio | Texts vendors, receives replies | ~$10–20 |
| **Internal Comms** | Slack Bot | Sends alerts, receives team updates | Free |
| **Project Data** | Jobtread API | Source of truth for all project and schedule data | Included in Jobtread plan |
| **CRM / Payments** | HubSpot API | Customer info and payment schedule reference | Included in HubSpot plan |
| **Calendar** | Google Calendar API | Creates and updates project milestone events | Free |
| | | **Estimated Total** | **~$60–150/month** |

---

## Summary of Integrations

| Tool | How the Agent Uses It |
|---|---|
| **Jobtread** | Read project schedules, task status, milestones; write updates and notes |
| **Slack** | Send daily reports, alerts, and status summaries; receive update posts from team |
| **SMS (Twilio)** | Outbound check-ins to vendors; receive and log their replies |
| **Google Calendar** | Create and update project milestone events |
| **HubSpot** | Reference customer contact info and payment schedules |

---

## Pricing

### One-Time Build Fee

| | |
|---|---|
| **MVP Development (20 hours @ $150/hr)** | $3,000 |
| Scope includes all 7 MVP cases, all integrations, database setup, testing, and deployment | |

---

### Monthly Retainer

The monthly retainer covers ongoing maintenance, monitoring, and minor adjustments to keep the agent running reliably.

| | Hours | Rate | Monthly Total |
|---|---|---|---|
| Monitoring & health checks | 1 hr | $150/hr | $150 |
| Prompt & behavior tuning | 1 hr | $150/hr | $150 |
| Bug fixes & integration maintenance | 1 hr | $150/hr | $150 |
| Client support & team questions | 1 hr | $150/hr | $150 |
| Minor tweaks & adjustments | 1 hr | $150/hr | $150 |
| **Retainer total (~5 hrs/month)** | | | **$750/month** |

> **Note:** The first 3 months typically run 10–15 hours as the system is tuned based on real usage. This is included in the retainer.

---

### Additional Work

Any work beyond the retainer scope (new features, major changes, additional integrations) is billed at **$150/hr** and requires approval before work begins.

---

### Infrastructure Costs

The following are pass-through costs billed at cost with no markup. Thomas Pools is responsible for these directly or they can be invoiced monthly.

| Service | Est. Monthly Cost |
|---|---|
| Railway (hosting) | ~$20–50 |
| Supabase (database) | Free tier |
| Twilio (SMS) | ~$10–20 |
| Claude API (AI) | ~$30–80 |
| **Total infrastructure** | **~$60–150/month** |

---

## Next Steps

1. **Discovery call** to walk through each active project and confirm how milestones and payment schedules are currently structured in Jobtread and HubSpot
2. **Jobtread API access** — we'll need an API key from your Jobtread account
3. **Vendor roster** — a list of subcontractors with phone numbers and trade categories
4. **Payment schedule template** — a copy of your standard contract payment structure so we can configure the payment reminder logic
5. **Slack workspace access** — bot installation in your Slack

---

*Questions or changes to this document? Contact your project team.*
