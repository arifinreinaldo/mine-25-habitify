# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server (PWA enabled in dev via devOptions)
npm run build    # tsc -b then vite build
npm run lint     # ESLint
npm run preview  # Preview production build

npx supabase functions deploy send-reminders   # deploy one edge function (repeat per function)
cd habitify_widget && flutter run               # Android widget companion app
```

No test runner is configured. Verification is `npm run build` (type-check) plus `npm run lint`.

## Architecture

React 19 + TypeScript + Vite PWA, Supabase (auth, Postgres, edge functions), Tailwind v3,
Radix primitives, React Router v7. Deployed to Cloudflare Pages.

### State lives in Dashboard.tsx

`src/pages/Dashboard.tsx` (~680 lines) owns all habit state: habits, completions,
progress values, notes, streaks, view mode, dialogs. `HabitList`, `HabitCard`,
`HabitCalendar`, and `HabitDialog` are presentational and take callbacks. Add habit
behavior in Dashboard, not in the card components.

Writes are optimistic: local state updates first, then Supabase, then revert on error.

### Data access goes through RPCs, not table selects

- `get_dashboard_data(p_year_ago)` returns habits + 365 days of completions in one call.
  The dashboard makes one round trip on load; do not split it back into two selects.
- `get_widget_data()` serves the Android widget (total habits, completed today, streak).

Both are `SECURITY DEFINER` and filter on `auth.uid()`. RLS covers direct table access.

### Schema

`supabase/setup.sql` is the entire schema — there is no migrations directory. Tables:
`habits`, `completions` (unique on habit_id+completed_at, date as YYYY-MM-DD),
`profiles` (timezone + `notify_push` / `notify_email` flags).

setup.sql is behind `src/types/habit.ts`: the TS types carry `habit_type`, `unit`, and
`completions.value`, which setup.sql does not create. Check the live database before
trusting either file.

### Notifications: two delivery paths, four cron/edge functions

`supabase/functions/` holds three Deno edge functions driven by pg_cron every 15 minutes
(the schedule SQL is commented out at the bottom of setup.sql and must be filled in per
deployment), plus one token-authenticated function invoked directly by notification
action buttons:

| Function | Transport | Profile flag | Fires when |
|---|---|---|---|
| `send-reminders` | Email — Brevo or Maileroo | `notify_email` | habit `reminder_time` matches a 5-minute window in the user's timezone |
| `send-ntfy-notifications` | FCM, via the `cloudflare-notifier` worker's `POST /push-fcm` | `notify_push` | same window logic |
| `send-streak-reminders` | FCM, via the same worker endpoint | `notify_push` | 18:00–23:00 local, at a slot derived from a hash of user_id |
| `complete-habit` | HTTP, called by a CloudPush notification action button | — | a "Mark Complete" / "Full Complete" / "Minimum Complete" action is tapped |

`send-reminders` is named like a generic reminder function but is the email sender — do
not infer transport from the name. `notify_push` keeps its old name but now means
"CloudPush / FCM", not Web Push.

FCM delivery goes through a single external worker, `cloudflare-notifier` (a separate
project, not part of this repo), at `POST {NOTIFIER_URL}/push-fcm`. The Android app
**CloudPush** subscribes to the user's FCM topic and renders the notification with action
buttons; there is no browser permission or per-device subscription on the web side.

`supabase/functions/_shared/notifier.ts` is the shared module the FCM functions import:
`userTopic`, `pushFcm`, `reminderActions`, `streakActions`, `mintActionToken`,
`completeUrl`. `pushFcm` never throws — a failed push is logged and returns `false`, so
one bad send cannot abort the batch.

FCM topics are derived from the email username: `${prefix}_${username}`, computed
identically in `src/components/CloudPushSettings.tsx` and in `_shared/notifier.ts`. Keep
the two in sync.

#### Background completion (`complete-habit`)

The completing action buttons (`Mark Complete`, `Full Complete`, `Minimum Complete`) are
background POSTs, not `ACTION_VIEW` links — tapping one must write the completion and
open nothing. `send-ntfy-notifications` and `send-streak-reminders` mint a short-lived
HMAC token (`mintActionToken`, `ACTION_TOKEN_SECRET`) binding `userId` + `target` (a
habit UUID or `"all"`) + `date`, and point the action at
`POST {SUPABASE_URL}/functions/v1/complete-habit` with the token in
`Authorization: Bearer` (never in the URL — the gateway logs URLs). `?t=` is still
accepted, for the browser GET path and for tokens minted before the switch.
`complete-habit` verifies
the token, then writes with a service-role client scoped by the token's own `userId` —
the token is the only authentication, since a CloudPush background POST carries no
Supabase JWT. Full contract: `docs/fcm-action-token-spec.md`.

`complete-habit` **must** run with JWT verification off — `supabase/config.toml` sets
`verify_jwt = false` for it. Supabase's API gateway otherwise rejects the (JWT-less)
request before this function's code ever runs. A bare gateway 401
(`{"code":401,"message":"Missing authorization header"}`) is the symptom of this setting
being lost, e.g. by a plain `supabase functions deploy complete-habit` without
`--no-verify-jwt` on a CLI version that does not honor the config file — see the spec's
section 8 for how to confirm the gateway is actually letting requests through.

Streak math exists in two places with different semantics — `src/lib/streaks.ts`
(current + best, counts today) and `calculateCurrentStreak` inside
`send-streak-reminders` (current only, starts at yesterday). The difference is
intentional; do not unify them.

### Android widget

`habitify_widget/` is a separate Flutter app (home screen widget). It receives its
Supabase session from the web app through a deep link — Dashboard's
`AndroidWidgetConnect` opens `habitify://auth?access_token=…&refresh_token=…` — stores it
in secure storage, and polls `get_widget_data()`.

### Deployment

`build.sh` is the Cloudflare Pages build command. It diffs `HEAD~1..HEAD` and skips the
build (writing a stub `dist/index.html`) when only `habitify_widget/` or `*.md` changed.
`public/_redirects` gives the SPA its catch-all route.

## Environment Variables

`.env` (see `.env.example`):

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

The FCM topic is **not** an environment variable and is never derived from the email.
Each profile carries a random `push_topic` (`habitify_<18 hex chars>`, defaulted by
Postgres). This is a credential, not an identifier: the push payload contains a habit
completion token, so anyone who can subscribe to the topic in CloudPush can complete
that user's habits. Senders read `profiles.push_topic` and skip a user without one;
`CloudPushSettings.tsx` displays it for the user to paste into CloudPush.

Edge function secrets (set with `npx supabase secrets set`): `NOTIFIER_URL` (the
`cloudflare-notifier` worker origin), `NOTIFIER_API_KEY` (sent as the `key` header),
`APP_URL` (Habitify origin for notification action links),
`ACTION_TOKEN_SECRET` (HMAC key for `complete-habit` action tokens — generate with
`openssl rand -base64 32`; read by `send-ntfy-notifications`, `send-streak-reminders`,
and `complete-habit`). `SUPABASE_SERVICE_ROLE_KEY` is provided by the platform.
`BREVO_API_KEY` / `MAILEROO_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME` are unchanged and
used only by `send-reminders`, the email function.
