-- Thomas Pools Agent — Database Schema
-- Generated from production with:
--   pg_dump "<prod>" --schema-only --schema=public --no-owner --no-privileges
-- Regenerate after schema changes so staging setup stays accurate (see docs/STAGING.md).

--
-- PostgreSQL database dump
--

\restrict mYADofGZVBScdHQaVhu4QWkOgQtUZAzA7nOr6JMFEUVe84Ou8V813sLZe73O5wf

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_run_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_type text NOT NULL,
    jobtread_job_id text,
    details jsonb,
    success boolean DEFAULT true NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_sync (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jobtread_task_id text NOT NULL,
    jobtread_job_id text NOT NULL,
    google_event_id text NOT NULL,
    task_name text NOT NULL,
    task_start text,
    task_end text,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cron_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cron_locks (
    lock_name text NOT NULL,
    acquired_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone
);


--
-- Name: daily_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_type text NOT NULL,
    slack_channel text NOT NULL,
    content text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outreach_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    jobtread_job_id text NOT NULL,
    message_sent text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    reply_text text,
    replied_at timestamp with time zone,
    status text DEFAULT 'sent'::text NOT NULL,
    twilio_message_sid text,
    escalated_at timestamp with time zone
);


--
-- Name: payment_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jobtread_job_id text NOT NULL,
    jobtread_job_name text NOT NULL,
    milestone_name text NOT NULL,
    amount numeric(10,2) NOT NULL,
    collected boolean DEFAULT false NOT NULL,
    collected_at timestamp with time zone,
    notified boolean DEFAULT false NOT NULL,
    notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pm_checkin_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pm_checkin_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_ts text NOT NULL,
    slack_channel_id text NOT NULL,
    jobtread_job_id text NOT NULL,
    jobtread_job_name text DEFAULT ''::text NOT NULL,
    pm_name text NOT NULL,
    pm_slack_user_id text NOT NULL,
    checkin_stage text DEFAULT ''::text NOT NULL,
    conversation_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    checkin_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    jobtread_task_id text,
    task_name text
);


--
-- Name: project_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slack_channel_id text NOT NULL,
    slack_channel_name text NOT NULL,
    jobtread_job_id text NOT NULL,
    jobtread_job_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed boolean DEFAULT true NOT NULL
);


--
-- Name: vendors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    trade text,
    jobtread_job_id text,
    jobtread_job_name text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_run_log agent_run_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_log
    ADD CONSTRAINT agent_run_log_pkey PRIMARY KEY (id);


--
-- Name: calendar_sync calendar_sync_jobtread_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync
    ADD CONSTRAINT calendar_sync_jobtread_task_id_key UNIQUE (jobtread_task_id);


--
-- Name: calendar_sync calendar_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync
    ADD CONSTRAINT calendar_sync_pkey PRIMARY KEY (id);


--
-- Name: cron_locks cron_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cron_locks
    ADD CONSTRAINT cron_locks_pkey PRIMARY KEY (lock_name);


--
-- Name: daily_reports daily_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_reports
    ADD CONSTRAINT daily_reports_pkey PRIMARY KEY (id);


--
-- Name: outreach_log outreach_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_pkey PRIMARY KEY (id);


--
-- Name: payment_schedules payment_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_pkey PRIMARY KEY (id);


--
-- Name: pm_checkin_threads pm_checkin_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_checkin_threads
    ADD CONSTRAINT pm_checkin_threads_pkey PRIMARY KEY (id);


--
-- Name: pm_checkin_threads pm_checkin_threads_thread_ts_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_checkin_threads
    ADD CONSTRAINT pm_checkin_threads_thread_ts_key UNIQUE (thread_ts);


--
-- Name: project_channels project_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_channels
    ADD CONSTRAINT project_channels_pkey PRIMARY KEY (id);


--
-- Name: project_channels project_channels_slack_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_channels
    ADD CONSTRAINT project_channels_slack_channel_id_key UNIQUE (slack_channel_id);


--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);


--
-- Name: outreach_log outreach_log_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_log
    ADD CONSTRAINT outreach_log_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.vendors(id);


--
-- Name: agent_run_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_run_log ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_sync; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_sync ENABLE ROW LEVEL SECURITY;

--
-- Name: cron_locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: outreach_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outreach_log ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: pm_checkin_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pm_checkin_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: project_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: vendors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict mYADofGZVBScdHQaVhu4QWkOgQtUZAzA7nOr6JMFEUVe84Ou8V813sLZe73O5wf

