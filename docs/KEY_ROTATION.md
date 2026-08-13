# Thomas Pools Agent — Key Rotation Schedule

## Summary

| Key | Location | Rotation interval | How to rotate |
|---|---|---|---|
| Jobtread grant key | Railway `JOBTREAD_GRANT_KEY` | Annually or on personnel change | Jobtread → Profile → Grants |
| Anthropic API key | Railway `ANTHROPIC_API_KEY` | Annually or on personnel change | console.anthropic.com → API Keys |
| Supabase service role key | Railway `SUPABASE_SERVICE_ROLE_KEY` | Annually | Supabase Dashboard → Project Settings → API |
| Slack bot token | Railway `SLACK_BOT_TOKEN` | On personnel change or suspected compromise | api.slack.com/apps → OAuth & Permissions |
| Slack app token | Railway `SLACK_APP_TOKEN` | On personnel change or suspected compromise | api.slack.com/apps → Basic Information → App-Level Tokens |
| Google service account key | Railway `GOOGLE_PRIVATE_KEY` + `GOOGLE_CLIENT_EMAIL` | Annually | Google Cloud Console → IAM → Service Accounts |
| Twilio API key | Railway `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` | Annually or on personnel change | Twilio Console → Account → API Keys |
| Twilio auth token | Railway `TWILIO_AUTH_TOKEN` | On suspected compromise only | Twilio Console → Account → General Settings |
| HubSpot access token | Railway `HUBSPOT_ACCESS_TOKEN` | Annually | HubSpot → Settings → Private Apps |

---

## Step-by-step rotation procedures

### Jobtread grant key

1. Log in to Jobtread as an admin.
2. Go to **Profile → Grants**.
3. Create a new grant key.
4. Update `JOBTREAD_GRANT_KEY` in Railway (Variables tab).
5. Railway will redeploy automatically. Verify the morning health check runs the next day.
6. Delete the old grant key from Jobtread.

### Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys**.
2. Create a new key.
3. Update `ANTHROPIC_API_KEY` in Railway.
4. Verify deployment succeeds, then delete the old key from the Anthropic console.

### Supabase service role key

> The service role key has full database access — treat it like a root password.

1. Go to Supabase Dashboard → your project → **Project Settings → API → JWT Settings**.
2. Click **Reset JWT secret** (or **Rotate JWT secret**). This regenerates both the `anon` and `service_role` keys.
3. Copy the new **service_role** key from the API settings page.
4. Update `SUPABASE_SERVICE_ROLE_KEY` in Railway. `SUPABASE_URL` does not change.
5. Railway will redeploy automatically. Verify the next health check runs successfully.

### Slack tokens

**Bot token (`SLACK_BOT_TOKEN`):**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → select **Thomas Pools Agent**.
2. Go to **OAuth & Permissions → Reinstall to Workspace**.
3. Copy the new `xoxb-` token.
4. Update `SLACK_BOT_TOKEN` in Railway.

**App-level token (`SLACK_APP_TOKEN`):**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → select **Thomas Pools Agent**.
2. Go to **Basic Information → App-Level Tokens**.
3. Delete the existing token and generate a new one with the same `connections:write` scope.
4. Update `SLACK_APP_TOKEN` in Railway.

### Google service account key

1. Go to [Google Cloud Console](https://console.cloud.google.com) → **IAM & Admin → Service Accounts**.
2. Select the `thomas-pools-agent` service account.
3. Go to **Keys → Add Key → Create new key → JSON**.
4. Download the JSON file.
5. From the JSON file, copy:
   - `client_email` → update `GOOGLE_CLIENT_EMAIL` in Railway
   - `private_key` → update `GOOGLE_PRIVATE_KEY` in Railway (paste the entire key including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`; Railway stores newlines as literal `\n` — paste as-is from the JSON file)
6. Verify the calendar sync runs correctly, then delete the old key from the service account's Keys tab.

### Twilio API key

1. Go to [Twilio Console](https://console.twilio.com) → **Account → API Keys & Tokens**.
2. Create a new Standard API key.
3. Copy the **SID** and **Secret** (the secret is only shown once).
4. Update `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` in Railway.
5. Verify vendor outreach works (use `VENDOR_OUTREACH_TEST_PHONE` for a safe test), then delete the old API key from Twilio.

### HubSpot access token

1. Go to HubSpot → **Settings → Integrations → Private Apps**.
2. Select the Thomas Pools Agent app.
3. On the app detail page, click **Rotate token** (if your HubSpot tier supports it) or delete and recreate the private app with the same scopes.
4. Copy the new token.
5. Update `HUBSPOT_ACCESS_TOKEN` in Railway.

---

## After any key rotation

1. Check Railway deployment logs — the service restarts automatically when an env var changes.
2. Trigger a manual health check: `curl -X POST https://thomas-pools-agent-production.up.railway.app/cron/morning -H "x-cron-secret: <secret>"`
3. Confirm the Slack post arrives in the morning channel.
4. If the agent errors after rotation, check `#agent-errors` and the Railway logs for the specific failure.

---

## What to do if a key is compromised

1. **Revoke the old key immediately** in the relevant console (do not wait).
2. Generate and deploy the new key to Railway.
3. Audit `agent_run_log` in Supabase for unexpected activity around the compromise window.
4. For the Jobtread grant key: also check Jobtread's audit log for unexpected mutations (comments, task updates).
5. For the Twilio auth token: check Twilio's usage logs for unexpected outbound messages.
