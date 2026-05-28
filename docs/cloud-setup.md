# Dashboard cloud configuration

How the Narbis Earclip Dashboard talks to Supabase for user accounts and per-session persistence. Written so a developer who's never seen the project can pick it up cold.

## TL;DR

| What | Where | Value |
|---|---|---|
| Supabase project | supabase.com → Narbis Edge org | `narbis-dashboard` (project ID `tmqfhxwxvoqtkcpbjjcg`) |
| Supabase URL | `https://tmqfhxwxvoqtkcpbjjcg.supabase.co` | committed to GH Actions secret `VITE_SUPABASE_URL` |
| Supabase anon key | publishable key (`sb_publishable_…`) | committed to GH Actions secret `VITE_SUPABASE_ANON_KEY` |
| Production URL | GitHub Pages | `https://narbiscorp.github.io/edge-earclip/app.html` |
| Schema source of truth | `dashboard/supabase/schema.sql` | already applied to the Supabase project |
| Local env file | `dashboard/.env.local` | gitignored — copy `.env.example` and fill in |
| Auth: email magic link | ✅ enabled | works today |
| Auth: Google OAuth | ⚠️ not enabled | see [Google OAuth](#google-oauth) below |
| Custom SMTP | ⚠️ not configured | see [Custom SMTP](#custom-smtp-for-production) below |
| Email branding | ✅ branded templates | uses Supabase built-in mailer |
| Bot protection | ⚠️ not enabled | see [Deferred work](#deferred-work) |

The dashboard works without any cloud config — live BLE tuning runs as a pure local app. Cloud features (sign-in, save, history, trends) require the Supabase config.

## Architecture

```
┌──────────────────────────┐      Web Bluetooth      ┌────────────┐
│  Dashboard (React/Vite)  │  ◀──────────────────▶   │  Earclip   │
│  github.io/edge-earclip  │                          │   (BLE)    │
└────────────┬─────────────┘                          └────────────┘
             │
             │  HTTPS (auth + REST)
             ▼
┌──────────────────────────┐
│  Supabase                │
│  • Postgres + RLS        │
│  • Auth (magic link)     │
│  • Built-in SMTP         │
└──────────────────────────┘
```

- Dashboard ships as a static SPA to GitHub Pages (no backend of our own).
- Supabase anon (publishable) key is inlined into the bundle at build time. Safe — RLS policies on the `sessions` table restrict each user to their own rows.
- Sessions ≥ 5 min auto-save when the End Session modal opens. Shorter sessions get a manual "Save this session" button.
- Save failures (offline, network) queue into IndexedDB (`pending_sync_sessions`) and flush automatically on the next online + auth event.

## Supabase project

- **Org**: Narbis Edge (free tier)
- **Project name**: `narbis-dashboard`
- **Project ID / ref**: `tmqfhxwxvoqtkcpbjjcg`
- **Region**: West US (Oregon) — `us-west-2`
- **Dashboard**: https://supabase.com/dashboard/project/tmqfhxwxvoqtkcpbjjcg
- **Database password**: stored in the project owner's password manager. Not used by the dashboard (the app uses the anon key); needed only for direct Postgres access or CLI migrations.

Owner: `dgreco@narbis.com`. To grant another developer access: Supabase dashboard → Project Settings → Project access → **Manage members** → invite their email.

## Database & RLS

Schema source of truth: [`dashboard/supabase/schema.sql`](../dashboard/supabase/schema.sql).

### One table

`public.sessions` — one row per saved training session. Columns map 1:1 to the in-memory session summary computed by `dashboard/src/sessions/buildSessionRow.ts`:

- Summary metrics: `avg_hr_bpm`, `avg_ibi_ms`, `ibi_sd_ms`, `rmssd_ms`, `avg_coherence`, `peak_coherence`, etc.
- Time-in-zone percentages: `low_coh_time_pct`, `med_coh_time_pct`, `high_coh_time_pct`
- Raw arrays: `ibi_log int[]`, `coherence_log_t_ms int[]`, `coherence_log_value smallint[]`
- Identity: `id uuid` (client-generated), `user_id uuid` (defaults to `auth.uid()`)
- Metadata: `notes`, `device_info jsonb`, `saved_via ('auto'|'manual')`, `schema_version int`

### Row-level security

Enabled on `sessions` with four policies (select / insert / update / delete own). Each policy is `auth.uid() = user_id`. The anon key bundled in the client cannot bypass this — a user can only ever see/modify their own rows.

### Adding a column

1. Edit `dashboard/supabase/schema.sql` (source of truth).
2. Apply the migration to the live project: write the `alter table sessions add column …` in Supabase SQL editor and run it.
3. Bump `SESSION_SCHEMA_VERSION` in `dashboard/src/sessions/types.ts` if the row shape changes meaningfully — that lets you spot old rows in queries later.
4. If the new column is computed, update `buildSessionRow.ts` and re-render in `SessionDetailModal.tsx`.

Never drop columns without a deprecation pass — there are real saved rows out there.

## Auth providers

### Magic link email (enabled)

Working today. User flow:

1. Header → "Sign in to save" → enter email → Supabase emails them a magic link.
2. They click it → redirected to `https://narbiscorp.github.io/edge-earclip/app.html?code=…`.
3. `@supabase/supabase-js` automatically exchanges the code for a session (we set `flowType: 'pkce'`, `detectSessionInUrl: true` in `dashboard/src/lib/supabase.ts`).
4. The auth store sees the new session, the header updates to show their email.

Subject lines + HTML bodies are customized — see [Email branding](#email-branding) below.

### URL configuration

Supabase needs to know which URLs are allowed redirect targets. Set under **Authentication → URL Configuration**:

- **Site URL**: `https://narbiscorp.github.io/edge-earclip/app.html`
- **Additional Redirect URLs**:
  - `https://narbiscorp.github.io/edge-earclip/app.html`
  - `http://localhost:5173/edge-earclip/app.html`

If you start serving the dashboard from a different path (e.g. a custom domain), update both fields. Otherwise magic links will redirect to a 404.

### Google OAuth

Not enabled yet. Clicking "Continue with Google" in the LoginModal currently returns `Unsupported provider: provider is not enabled`. To enable:

#### 1. Create OAuth client in Google Cloud

1. Go to https://console.cloud.google.com/apis/credentials
2. Pick (or create) a project. Suggested name: `Narbis Dashboard`.
3. **APIs & Services → OAuth consent screen**
   - User type: External
   - App name: `Narbis Dashboard`
   - User support email: `dgreco@narbis.com`
   - Authorized domain: `supabase.co` (so Supabase's callback domain is trusted)
   - Scopes: leave default (email, profile, openid)
   - Publish status: keep in **Testing** until you launch to real users; add your team's emails to "Test users". Production status takes a Google review.
4. **Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Narbis Dashboard Web Client`
   - **Authorized redirect URIs**: Supabase tells you the exact URL — it's `https://tmqfhxwxvoqtkcpbjjcg.supabase.co/auth/v1/callback`. Paste that.
   - Click Create. Copy the **Client ID** and **Client Secret**.

#### 2. Plug into Supabase

1. Supabase dashboard → **Authentication → Providers → Google**
2. Toggle **Enable Sign in with Google** on
3. Paste **Client ID** and **Client Secret** from Google Cloud
4. Save

#### 3. Test

`npm run dev`, click Sign in → Continue with Google. Should bounce to Google's account picker and back to the dashboard authenticated.

Heads-up: while the OAuth consent screen is in **Testing** mode, only emails added to the Test Users list can sign in. To go fully public, you'd submit for Google's verification review — not blocking for internal/research use.

## Email configuration

### Email branding

Templates are customized for our flow. Edit under **Authentication → Emails → Templates** in the Supabase dashboard.

| Template | Subject | Used when |
|---|---|---|
| Confirm sign up | `Welcome to Narbis — confirm your email` | First-time user (signup via magic link) |
| Magic link or OTP | `Sign in to Narbis` | Returning user (re-auth via magic link) |

HTML bodies for both are committed at [`dashboard/supabase/email-templates/`](../dashboard/supabase/email-templates/) (if you want to round-trip edits via PR review instead of just editing in the Supabase UI — Supabase doesn't sync them anywhere, so the committed copy is informational only and may drift). Keep both in sync if you change one.

Variables available: `{{ .Email }}`, `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .SiteURL }}`, `{{ .RedirectTo }}`.

### Custom SMTP (for production)

⚠️ **Not yet configured.** The built-in Supabase mailer is fine for testing but is rate-limited (~4 emails/hour) and emails come from `noreply@mail.app.supabase.io` (looks spammy, often lands in junk). Before onboarding real participants you should switch to a custom SMTP provider.

Recommended: **Resend** (free 100/day, simplest setup).

#### 1. Pick an SMTP provider and verify a sending domain

Using Resend as the example:

1. Sign up at https://resend.com.
2. **Domains → Add Domain** — choose the domain emails should come from (e.g. `narbis.com` or a subdomain like `mail.narbis.com`).
3. Resend gives you a set of DNS records (SPF, DKIM, sometimes DMARC) to add to your DNS provider.
4. Add those records to whoever hosts narbis.com's DNS (Cloudflare, GoDaddy, etc.). Wait 5-15 min for verification.
5. Once verified, Resend marks the domain as Active.
6. **API Keys → Create API Key** — copy the key.

Resend's SMTP credentials:
- Host: `smtp.resend.com`
- Port: `465` (TLS) or `587` (STARTTLS)
- Username: `resend`
- Password: your API key from step 6

#### 2. Plug into Supabase

1. Supabase dashboard → **Authentication → Emails → SMTP Settings** tab
2. Enable Custom SMTP
3. Sender details:
   - **From email**: `noreply@narbis.com` (or wherever your verified domain sends from)
   - **From name**: `Narbis`
4. SMTP credentials: paste host / port / username / password from above
5. Save → use the "Send test email" feature to verify delivery
6. Re-test sign-in end-to-end from the live dashboard

#### 3. Other options

| Provider | Free tier | Notes |
|---|---|---|
| Resend | 100/day, 3000/mo | Simplest setup. Recommended. |
| Postmark | 100/mo trial then paid | Best deliverability reputation. Paid only after trial. |
| SendGrid | 100/day forever | Older, fiddlier interface but free tier is generous |
| Amazon SES | $0.10/1000 after first 62k | Cheapest at scale, painful to set up if you're not already in AWS |

## API keys & secrets

### Two values, two places

| Variable | Local (`dashboard/.env.local`) | Production (GH Actions secret) |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | yes |
| `VITE_SUPABASE_ANON_KEY` | yes | yes |

Both values are identical between local and prod. The local file is gitignored; the GH Actions secrets are at `https://github.com/narbiscorp/edge-earclip/settings/secrets/actions`.

### Which key

Supabase exposes several keys under **Project Settings → API Keys**:

| Key type | Use for the dashboard? | Notes |
|---|---|---|
| Publishable (`sb_publishable_…`) | ✅ **yes** | Modern equivalent of the old "anon" key. Safe to ship to the browser. |
| Legacy anon (JWT `eyJ…`) | ✅ also works | Older format. Same security model. |
| Secret (`sb_secret_…`) | ❌ **never** | Admin-powers. Equivalent to old `service_role`. Would let any browser bypass RLS. |
| Legacy service_role | ❌ **never** | Same warning as above. |

### Rotating a key

If a key is exposed (or just on principle every N months):

1. Supabase dashboard → **API Keys** → **Rotate** the publishable key
2. Update `VITE_SUPABASE_ANON_KEY` in:
   - `dashboard/.env.local` on every developer's machine
   - GH Actions secret at `https://github.com/narbiscorp/edge-earclip/settings/secrets/actions`
3. Trigger a re-deploy (push to `main` or manually run the workflow)
4. Old key keeps working for a brief grace period, then dies

## Local development setup

Prerequisites: Node 20+, npm, git, a Chromium-based browser (Web Bluetooth doesn't work on Firefox or iOS Safari).

```bash
git clone https://github.com/narbiscorp/edge-earclip.git
cd edge-earclip/dashboard

# Set up env vars
cp .env.example .env.local
# Then edit .env.local and paste the two VITE_SUPABASE_* values
# (get from .env.local of an existing dev's machine, or from a 1Password / Bitwarden vault if set up)

npm install
npm run dev
```

Open http://localhost:5173/edge-earclip/app.html.

If the header shows "Sign in to save", env vars are loading correctly. If it doesn't, open DevTools console and look for a `[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set` warning.

## Production deployment

### Where it lives

- **URL**: https://narbiscorp.github.io/edge-earclip/app.html
- **Hosting**: GitHub Pages
- **Build & deploy**: [`.github/workflows/dashboard-deploy.yml`](../.github/workflows/dashboard-deploy.yml)
- **Trigger**: push to `main` that touches `dashboard/**`, `webapp/ota/**`, `docs/**`, or `index.html`. Also manually triggerable from the Actions tab.

### Re-deploying manually

If you change env secrets or want to force a rebuild without code changes:

1. Go to https://github.com/narbiscorp/edge-earclip/actions/workflows/dashboard-deploy.yml
2. Click **Run workflow** (top right)
3. Branch: `main`
4. Click the green Run workflow button
5. Wait ~2 min for the green check

### Verifying a deploy

1. Watch the workflow run complete green at the Actions URL above.
2. Hard-refresh the prod page: `Ctrl+Shift+R`.
3. Confirm the build ID in the Expert-mode header (`relay-v5 · <yyyymmddhhmmss>-<sha>`) matches the latest commit.

## Common operations

### Onboarding a new developer

1. Add them to the GitHub repo (`Settings → Collaborators`).
2. Add them to the Supabase project (`Project Settings → Project access → Manage members`).
3. Send them their two env values securely (via password manager share, NOT email):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. They clone, copy `.env.example` to `.env.local`, paste, run.

### Inviting a participant (once you outgrow open signup)

Today: anyone with an email can sign up. To switch to invite-only:

1. Supabase dashboard → **Authentication → Sign In / Providers → Email** → toggle off "Enable Sign Ups"
2. To invite someone: **Authentication → Users → Invite user** → enter email. They get an invite link.
3. Document the invite policy somewhere (e.g. who can invite, audit log).

### Looking at a user's data

You can't impersonate a user from the browser (RLS scopes everything to `auth.uid()`). To inspect a specific user's sessions:

- Supabase dashboard → **Table Editor → sessions** → filter by `user_id`
- Or **SQL Editor**:
  ```sql
  select * from sessions
   where user_id = (select id from auth.users where email = 'someone@example.com')
   order by started_at desc;
  ```

The Supabase dashboard runs queries with service-role privileges, so it bypasses RLS — be careful what you query and who can do it.

### Deleting a user account

Free tier doesn't expose self-serve account deletion from the client. To honor a delete request:

1. Supabase dashboard → **Authentication → Users** → find user → delete
2. Their `sessions` rows are deleted automatically via `ON DELETE CASCADE` in the schema.

Future enhancement: add an "Account → Delete account" button that calls a Supabase Edge Function with service-role permission to do this. Not built yet.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Sign in to save" pill doesn't appear in header | Env vars not loaded into the build | Check DevTools console for `[supabase] … not set`. If local: check `.env.local` exists and Vite was restarted after creating it. If prod: check GH Actions secrets exist, re-trigger deploy, hard-refresh. |
| Magic link email redirects to 404 / wrong domain | Site URL or Additional Redirect URLs in Supabase doesn't include the page you're on | Supabase dashboard → Authentication → URL Configuration → add the URL |
| "Unsupported provider: provider is not enabled" when clicking Google | OAuth provider not configured | See [Google OAuth](#google-oauth) section |
| Magic link emails landing in spam | Built-in Supabase mailer + `mail.app.supabase.io` sender | See [Custom SMTP](#custom-smtp-for-production) section |
| "Email rate limit exceeded" | Built-in mailer's ~4/hour limit | Same — set up custom SMTP |
| Session saved successfully but not appearing in history | RLS mismatch — likely `user_id` was wrong | Check the row in Supabase Table Editor; `user_id` should equal `auth.uid()` for the signed-in user. The schema sets `default auth.uid()` so this shouldn't happen unless someone explicitly set a different value. |
| Save shows "Saved (offline — will sync)" indefinitely | Pending sync queue not draining | Check `navigator.onLine` is true and auth status is `signed_in`. Inspect IDB: DevTools → Application → IndexedDB → `narbis-dashboard` → `pending_sync_sessions`. |
| TypeScript build fails after pulling | Likely a Supabase SDK version mismatch | `cd dashboard && rm -rf node_modules package-lock.json && npm install` |

## Deferred work

Not built yet, listed roughly in priority order:

1. **Custom SMTP** — required before real users can sign up reliably. See [Custom SMTP](#custom-smtp-for-production).
2. **Google OAuth** — improves sign-in UX. See [Google OAuth](#google-oauth).
3. **Bot protection (hCaptcha)** — Supabase has a built-in toggle under **Authentication → Bot & Abuse Protection**. Free, recommended before real production launch.
4. **Auth rate limits** — tighten signup rate at **Authentication → Rate Limits** (default ~30/hour is too loose for open signup).
5. **Self-serve account deletion** — Edge Function + UI button. Today: manual via Supabase dashboard.
6. **Invite-only signup** — switch off public signup and use the Invite Users flow when you stop accepting all comers.
7. **HIPAA tier** — Supabase Team plan ($599/mo) is required if Narbis is ever positioned as medical (not wellness). Don't store actual PHI on the free tier.
8. **Migrate raw IBI to Supabase Storage** — current schema holds `ibi_log` in a Postgres `int[]` column (fine to ~10k sessions/user). If usage explodes, move to Supabase Storage blob and keep just the summary columns in Postgres.
9. **Trends UI** — current charts (RMSSD line + time-in-zone bars + KPI strip) cover the basics. More cuts to add later: weekly streaks, day-of-week patterns, mood/notes word cloud.

## Reference files

| Concern | File |
|---|---|
| Supabase client init | `dashboard/src/lib/supabase.ts` |
| Auth state | `dashboard/src/auth/authStore.ts` |
| Login modal UI | `dashboard/src/auth/LoginModal.tsx` |
| Header sign-in pill | `dashboard/src/auth/AuthButton.tsx` |
| Session save | `dashboard/src/sessions/saveSession.ts` |
| Row construction | `dashboard/src/sessions/buildSessionRow.ts` |
| Offline queue | `dashboard/src/sessions/pendingSyncQueue.ts` |
| History list / trends UI | `dashboard/src/sessions/{HistoryView,SessionList,SessionDetailModal,TrendsView}.tsx` |
| Schema source of truth | `dashboard/supabase/schema.sql` |
| Build-time env injection | `.github/workflows/dashboard-deploy.yml` |
| Local env template | `dashboard/.env.example` |
