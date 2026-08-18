-- Thomas Pools Agent — Database Schema

-- 1. Maps Slack channels to Jobtread projects
create table project_channels (
  id uuid primary key default gen_random_uuid(),
  slack_channel_id text not null unique,
  slack_channel_name text not null,
  jobtread_job_id text not null,
  jobtread_job_name text not null,
  confirmed boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Vendor/subcontractor roster
create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  trade text,
  jobtread_job_id text,
  jobtread_job_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3. SMS outreach log — tracks every message sent and reply received
create table outreach_log (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id),
  jobtread_job_id text not null,
  message_sent text not null,
  sent_at timestamptz not null default now(),
  reply_text text,
  replied_at timestamptz,
  status text not null default 'sent', -- sent | replied | escalated | no_reply
  twilio_message_sid text,
  escalated_at timestamptz
);

-- 4. Payment schedules per project
create table payment_schedules (
  id uuid primary key default gen_random_uuid(),
  jobtread_job_id text not null,
  jobtread_job_name text not null,
  milestone_name text not null,
  amount numeric(10, 2) not null,
  collected boolean not null default false,
  collected_at timestamptz,
  notified boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);

-- 5. Audit log of every action the agent takes
create table agent_run_log (
  id uuid primary key default gen_random_uuid(),
  run_type text not null, -- morning_check | vendor_outreach | payment_check | evening_report | status_query | slack_update
  jobtread_job_id text,
  details jsonb,
  success boolean not null default true,
  error_message text,
  created_at timestamptz not null default now()
);

-- 7. Tracks which Jobtread tasks have been synced to Google Calendar
create table calendar_sync (
  id uuid primary key default gen_random_uuid(),
  jobtread_task_id text not null unique,
  jobtread_job_id text not null,
  google_event_id text not null,
  task_name text not null,
  task_start text,
  task_end text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 9. PM check-in threads — tracks per-job Slack threads and conversation state
create table pm_checkin_threads (
  id uuid primary key default gen_random_uuid(),
  thread_ts text not null unique,
  slack_channel_id text not null,
  jobtread_job_id text not null,
  jobtread_job_name text not null default '',
  pm_name text not null,
  pm_slack_user_id text not null,
  checkin_stage text not null default '',
  conversation_history jsonb not null default '[]',
  status text not null default 'pending', -- pending | confirmed | delayed | resolved
  checkin_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- 8. Distributed cron lock — prevents duplicate runs across Railway redeploys or concurrent triggers
create table cron_locks (
  lock_name text primary key,
  acquired_at timestamptz not null,
  released_at timestamptz
);

-- 6. Archive of all daily reports sent
create table daily_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null, -- morning | evening
  slack_channel text not null,
  content text not null,
  sent_at timestamptz not null default now()
);
