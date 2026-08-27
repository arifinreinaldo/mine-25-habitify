# Spec — Replace ntfy + Web Push with FCM via cloudflare-notifier

Habitify's push notifications move to a single transport: the `cloudflare-notifier`
worker's `POST /push-fcm` endpoint. The CloudPush Android app receives the FCM topic
message and shows the notification. Web Push (VAPID) and ntfy.sh are removed entirely.

Email notifications are **not** part of this change and must keep working.

The reader of this spec has no conversation context. Every contract detail is here.

---

## 1. Current state (verified, not remembered)

Five edge functions exist in `supabase/functions/`. Their names do not describe their
transports — read the table, do not infer from the name:

| Function | Actual transport | Profile flag | Fate |
|---|---|---|---|
| `send-reminders` | **Email** — Brevo `api.brevo.com/v3/smtp/email` or Maileroo (`index.ts:159`) | `notify_email` | **DO NOT TOUCH** |
| `send-ntfy-notifications` | ntfy.sh (`index.ts:63`) | `notify_ntfy` | Convert to FCM |
| `send-streak-reminders` | ntfy.sh (`index.ts:191`) | `notify_ntfy` | Convert to FCM |
| `send-push-notifications` | Web Push (`webpush.sendNotification`, `index.ts:66`) | `notify_push` | **Delete** |
| `send-streak-push-notifications` | Web Push (`index.ts:192`) | `notify_push` | **Delete** |

`send-reminders` is named like a generic reminder function but is the email sender. It
requires `BREVO_API_KEY` or `MAILEROO_API_KEY` and throws without one. Leave its file,
its cron entry, and `notify_email` alone.

After this change: 3 functions — 1 email, 2 FCM.

The flag `notify_push` **keeps its name** and now means "CloudPush / FCM". `notify_ntfy`
is dropped. Do not invent a `notify_fcm` column.

---

## 2. The worker contract (verified against `C:\Users\Reinaldo\Backend\cloudflare_notifier`)

### Request

```
POST {NOTIFIER_URL}/push-fcm
key: {NOTIFIER_API_KEY}
content-type: application/json

{
  "title": "...",
  "body": "...",
  "fcm-topic": "habitify_reinaldo",
  "action": [
    { "url": "https://app.example/dashboard", "label": "Open" },
    { "url": "https://app.example/dashboard?complete=<uuid>", "label": "Mark Complete" }
  ]
}
```

Details that a competent guess gets wrong:

- **The auth header is literally `key`.** Not `Authorization`, not `Bearer`. (`x-api-key`
  and an `apiKey` body field also work; use `key`.)
- **Send `action` as a JSON array of objects**, not a comma-joined string. `readFields()`
  (`src/index.js:230`) returns the parsed JSON object as-is, and `parseActions`
  (`src/index.js:247`) accepts `{url, label}` objects. The comma/pipe string form also
  parses, but the object form is the documented escape hatch for URLs containing `,` or
  `|` — use it and delimiter bugs become impossible.
- **`data.click` = `actions[0].url`** (`src/fcm.js:32`). Tapping the notification *body*
  fires the first action, not "just open the app". Therefore **`Open Reminder` must
  always be `actions[0]`**. Any completing action in that slot makes an accidental
  body-tap write a completion.
- **Max 3 actions, label max 40 chars, http(s) URLs only.** Violations return 422. The
  streak push uses all three slots — there is no room for a fourth.
- **`fcm-topic` charset** is `/^[A-Za-z0-9._~%-]{1,900}$/` (`validateFcm`,
  `src/index.js:218`). Underscore **is** in that set, so the existing
  `habitify_<username>` topic is valid unchanged. No renaming.
- Unknown extra fields are ignored, never forwarded to FCM.
- `title` 1..256 chars, `body` 1..4096 chars. Both required.

### Response

Follows the worker's `docs/api-standard.md`:

| Situation | Status | Meaning |
|---|---|---|
| Sent | 200 | `{message, data:{results:[{channel:'fcm',ok:true}]}}` |
| FCM down / throttled | 503 | retryable, `Retry-After: 30` |
| FCM rejected the message | 502 | **not** retryable — bad service account or malformed message |
| Validation failed | 422 | `errors` names the bad field |
| Bad or missing API key | 401 | |

Edge functions must **log and continue** on any non-2xx — one user's failed push must
never abort the batch for every other user. Do not retry inside the function; pg_cron
runs again in 15 minutes.

---

## 3. Deliverables

### 3.1 NEW — `supabase/functions/_shared/notifier.ts`

Deno module, imported by both FCM functions. Supabase bundles `_shared/` into each
function that imports it; it is not deployed on its own.

```ts
export interface PushAction {
  url: string;
  label?: string;
}

/** habitify_<sanitised email username>. Must stay byte-identical to the client copy
 *  in src/components/CloudPushSettings.tsx — the user reads the topic there and types
 *  it into CloudPush. */
export function userTopic(prefix: string, email: string): string;

/** Returns true when the worker answered 2xx. Logs and returns false otherwise —
 *  never throws, so one bad push cannot kill the batch. */
export function pushFcm(opts: {
  title: string;
  body: string;
  topic: string;
  actions?: PushAction[];
}): Promise<boolean>;

/** Reminder push (one specific habit): [Open Reminder, Mark Complete]. */
export function reminderActions(appUrl: string, habitId: string): PushAction[];

/** Streak push (N incomplete habits): [Open Reminder, Full Complete, Minimum Complete].
 *  minimumHabitId is the single habit "Minimum Complete" ticks. */
export function streakActions(appUrl: string, minimumHabitId: string): PushAction[];
```

Both put `Open Reminder` in slot 0 — that slot is also the notification body tap
(section 2), so it must never complete anything.

| Label | URL | Meaning |
|---|---|---|
| `Open Reminder` | `{appUrl}/dashboard` | just opens the app |
| `Mark Complete` | `{appUrl}/dashboard?complete={habitId}` | ticks that one habit |
| `Full Complete` | `{appUrl}/dashboard?complete=all` | ticks every habit scheduled today that is not already done |
| `Minimum Complete` | `{appUrl}/dashboard?complete={minimumHabitId}` | ticks exactly one habit |

`all` is the literal string `all`. It cannot collide with a habit id — those are UUIDs.
`Mark Complete` and `Minimum Complete` are the same URL shape with different labels;
they differ only in which notification carries them.

`userTopic` body — copy exactly, it already exists at
`supabase/functions/send-ntfy-notifications/index.ts:48`:

```ts
const username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
return `${prefix}_${username}`;
```

`pushFcm` reads `NOTIFIER_URL` and `NOTIFIER_API_KEY` from `Deno.env`. Missing either →
log an error and return false. Strip trailing slashes from `NOTIFIER_URL`. Use
`AbortSignal.timeout(10_000)`. On non-2xx, log the status plus the first 200 chars of the
response body — **never log `NOTIFIER_API_KEY`**.

Both action builders take `appUrl` from `Deno.env.get("APP_URL")` at the call site, with
trailing slashes stripped.

### 3.2 CONVERT — `supabase/functions/send-ntfy-notifications/index.ts`

Keep the file path and function name (its cron entry and deploy target stay valid).
Keep **all** existing logic: the message array, `getRandomMessage`, the per-user
timezone 5-minute window match, the `frequency_days` day-of-week check, and the
already-completed-today check.

Change only:

1. Delete the local `sendNtfyNotification` function and the local `getUserTopic`; import
   `userTopic`, `pushFcm`, `habitActions` from `../_shared/notifier.ts`.
2. Read `FCM_TOPIC_PREFIX` instead of `NTFY_TOPIC` (`index.ts:96`). Same role — it is a
   *prefix*, not a full topic, despite the old name.
3. Profile query filter: `notify_ntfy` → `notify_push` (`index.ts:137-139`), and select
   `notify_push`.
4. Send via `pushFcm({ title, body, topic: userTopic(prefix, email), actions:
   reminderActions(appUrl, habit.id) })`. Title stays the habit name with its icon
   exactly as the existing code builds it; body stays `getRandomMessage(habit.name)`.

This function fires for **one specific habit** whose `reminder_time` just matched, so it
gets `Mark Complete`, not the Full/Minimum pair — with a single habit those two would be
the same action.

The ntfy `priority` and `tags` fields have no FCM equivalent — drop them, do not try to
map them into `data`.

### 3.3 CONVERT — `supabase/functions/send-streak-reminders/index.ts`

Same treatment. Keep **all** existing logic: every message array (`streakMessages`,
`multiHabitMessages`, `urgentMessages`), `getRandomMessage`, `shouldSendNotification`
(the 18:00–23:00 user_id-hash slot), and `calculateCurrentStreak`.

**Do not "fix" `calculateCurrentStreak`.** It starts its loop at `i = 1` (yesterday),
unlike `src/lib/streaks.ts` which starts at `i = 0` (today). That difference is
intentional — the streak nudge asks "your streak so far is N, do not break it tonight".
Changing it changes every message users see.

Changes:

1. Import from `../_shared/notifier.ts`; delete the local ntfy sender and `getUserTopic`.
2. `NTFY_TOPIC` → `FCM_TOPIC_PREFIX`.
3. Profile filter `notify_ntfy` → `notify_push`.
4. Actions: `streakActions(appUrl, habitWithMaxStreak.id)` →
   `[Open Reminder, Full Complete, Minimum Complete]`.

   **`habitWithMaxStreak` already exists** in this function — it is computed in the
   `for (const habit of incompleteHabits)` loop that picks the highest
   `calculateCurrentStreak`, and the function already early-`continue`s unless
   `maxStreak > 5 && habitWithMaxStreak` is truthy. So by the send site it is always
   non-null. Do not recompute it, and do not pick a different habit: the one with the
   most streak to lose is exactly what "Minimum Complete" should save.

### 3.4 DELETE

- `supabase/functions/send-push-notifications/` (whole directory)
- `supabase/functions/send-streak-push-notifications/` (whole directory)
- `src/lib/pushNotifications.ts`
- `src/hooks/usePushNotifications.ts`
- `src/components/NotificationSettings.tsx`
- `public/sw-push.js`

### 3.5 EDIT — `vite.config.ts`

Remove the line `importScripts: ['sw-push.js'],` and its comment from the `workbox`
block. Leaving it after deleting the file breaks the service-worker build. Change
nothing else in this file — the PWA manifest, the icons, and the Supabase
`runtimeCaching` rule all stay.

### 3.6 RENAME + REWRITE — `src/components/NtfySettings.tsx` → `src/components/CloudPushSettings.tsx`

Export `CloudPushSettings` (same shape: no props, returns `null` when `!user?.email`).

Keep the topic derivation identical to `userTopic` in the shared module, reading the
prefix from `import.meta.env.VITE_FCM_TOPIC_PREFIX || 'habitify'`.

Content: the topic in a copyable `<code>` block with the existing copy-to-clipboard
button (keep that code as-is), and setup steps rewritten for CloudPush:

1. Install the **CloudPush** app
2. Open Subscriptions, add a topic, paste the topic above
3. Done — habit reminders arrive there

Remove the "Open in ntfy.sh" button and the `https://ntfy.sh/...` URL entirely.

### 3.7 EDIT — `src/hooks/useNotificationPreferences.ts`

- `NotificationChannel` type: `'notify_push' | 'notify_email'` (drop `'notify_ntfy'`)
- `NotificationPreferences` interface: drop `notify_ntfy`
- Default state, the `.select(...)` string, and the response mapping: drop `notify_ntfy`

Leave the optimistic-update-and-rollback logic and the `PGRST116` / missing-column
fallback exactly as they are.

### 3.8 EDIT — `src/components/NotificationPreferences.tsx`

FCM delivery needs **no browser permission and no per-device subscription** — the phone
subscribes in CloudPush, not here. Remove the whole Web Push dance:

- Delete the `usePushNotifications` import and the `push` variable
- Delete `pushBusy`, `handlePushToggle`, `getPushDescription`, `pushNotSupported`,
  `pushNotConfigured`, `pushDenied`, `pushDisabled`, and the `push.error` block
- The `channels` array becomes two entries:
  - `notify_push` — icon `Smartphone`, label `"Phone (CloudPush)"`, description
    `"Push notifications via the CloudPush app"`
  - `notify_email` — icon `Mail`, label `"Email"`, description `"Reminder emails"`
- Every switch becomes the plain `updatePreference(channel.key, checked)` path; no
  special-casing, no disabled state

Keep the loading state and the `error` display.

### 3.9 EDIT — `src/pages/Dashboard.tsx`

**a. Imports (lines 10-12):** drop `NotificationSettings` and `NtfySettings`; add
`CloudPushSettings`.

**b. Settings dialog (lines 669-671):** `<NotificationSettings />` and `<NtfySettings />`
become a single `<CloudPushSettings />`, rendered after `<NotificationPreferences />`.
`<AndroidWidgetConnect />` (line 672) stays.

**c. NEW — the `?complete=<habitId>` handler.** This is the "action updates the streak"
half of the feature. Nothing currently reads this parameter; `public/sw-push.js:57`
emitted the URL but no consumer ever existed.

It accepts two forms:

| Param | Completes |
|---|---|
| `?complete=all` | every habit scheduled today that is not already done |
| `?complete=<uuid>` | that one habit |

Place it after `handleToggleHabit`'s definition. Add `useRef` to the React import.

```tsx
const completeParamHandled = useRef(false);

useEffect(() => {
    if (loading || completeParamHandled.current) return;
    const param = new URLSearchParams(window.location.search).get('complete');
    if (!param) return;
    completeParamHandled.current = true;
    // Strip the param so a refresh does not re-fire the completion.
    window.history.replaceState({}, '', window.location.pathname);

    const pending = param === 'all'
        ? todaysHabits.filter(h => !completedIds.has(h.id))
        : todaysHabits.filter(h => h.id === param && !completedIds.has(h.id));
    if (pending.length === 0) return;

    (async () => {
        const { error } = await supabase.from('completions').insert(
            pending.map(h => ({
                habit_id: h.id,
                user_id: user!.id,
                completed_at: today,
                value: 1,
            }))
        );
        if (error) {
            console.error('Error completing from notification:', error);
            return;
        }
        await fetchData();
    })();
}, [loading, todaysHabits, completedIds, user]);
```

Six constraints a naive version gets wrong:

- **Must wait for `loading === false`.** `completedIds` is empty until `fetchData`
  resolves; acting early re-inserts completions that already exist and hits the
  `UNIQUE(habit_id, completed_at)` constraint.
- **Must filter out already-completed habits.** That same unique constraint makes a
  duplicate insert fail — and with a bulk insert one duplicate row **fails the whole
  batch**, so a "Full Complete" tap would silently complete nothing.
- **Must filter through `todaysHabits`, not `habits`.** That memo (`Dashboard.tsx:93`)
  applies the `frequency_days` day-of-week check. It also makes an unknown, archived, or
  foreign id resolve to an empty list, so a junk URL is a no-op instead of an FK error.
- **Do not route this through `handleToggleHabit`.** It *toggles* (`Dashboard.tsx:200`) —
  on an already-completed habit it **deletes** the completion and breaks the very streak
  the notification was trying to save. It also does one round trip per habit. The bulk
  insert above is one round trip for the whole batch.
- **The ref guard is required.** The effect's deps change on every state update; without
  the latch it re-fires. Set it *before* the async work, not after.
- **`await fetchData()` at the end is the point of the feature.** `handleToggleHabit`
  never recalculates `streakData` — streaks only refresh on a full load. Since this whole
  flow exists to answer a "your streak is dying" notification, the user must land on an
  updated streak. Re-running `fetchData` refreshes completions, progress, and streaks in
  one call.

Use the existing module-scope `today` constant (`Dashboard.tsx:73`) — do **not**
recompute the date here. `completedIds` was built from that same constant, so a fresh
`new Date()` would compare against a different day. (`today` being module-scope is a
real pre-existing bug for a tab left open past midnight. It is **out of scope**; do not
refactor it.)

`value: 1` matches what `handleToggleHabit` writes (`Dashboard.tsx:236`), including for
measurable habits. Do not substitute `frequency_target` — that would diverge from what
the checkbox does.

`fetchData` is intentionally absent from the dependency array, mirroring the existing
`useEffect` at `Dashboard.tsx:106` which calls it the same way and passes lint today.

### 3.10 EDIT — `supabase/setup.sql`

- Delete the `push_subscriptions` table, its index, its RLS enable, and its policy
  (section 6). Add `DROP TABLE IF EXISTS push_subscriptions;` to the migration notes for
  existing databases.
- `profiles`: remove `notify_ntfy` from the CREATE TABLE. In the migration comments
  (section 7) replace the `notify_ntfy` line with
  `ALTER TABLE profiles DROP COLUMN IF EXISTS notify_ntfy;`
- Cron block (section 8): three schedules — `send-reminders`, `send-ntfy-notifications`,
  `send-streak-reminders`. Delete the `send-streak-push-notifications` schedule. Keep the
  block commented out and keep the `YOUR_SUPABASE_URL` / `YOUR_ANON_KEY` placeholders.
- `get_dashboard_data` and `get_widget_data` are untouched.

### 3.11 EDIT — `.env.example`

```
VITE_SUPABASE_URL=YOUR_SUPABASE_URL
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY

# CloudPush / FCM notifications - user topic = prefix_username
VITE_FCM_TOPIC_PREFIX=habitify
```

Delete `VITE_VAPID_PUBLIC_KEY` and `VITE_NTFY_TOPIC_PREFIX`.

### 3.12 EDIT — `CLAUDE.md`

Update the "Notifications" section to the post-change reality: 3 functions, the table in
section 1 of this spec, the worker as the push transport, CloudPush as the receiver.
Correct the existing error that lists `send-reminders` as ntfy — it is email. Update the
environment variable list to match 3.11 and the secrets list to section 4.

---

## 4. Secrets and environment

Supabase edge function secrets (`npx supabase secrets set`) — **the operator sets these,
the implementer only reads them**:

| Name | Purpose |
|---|---|
| `NOTIFIER_URL` | Worker origin, e.g. `https://cloudflare-notifier.<sub>.workers.dev` |
| `NOTIFIER_API_KEY` | The worker's `API_KEY`, sent as the `key` header |
| `FCM_TOPIC_PREFIX` | Topic prefix, e.g. `habitify` |
| `APP_URL` | Habitify origin for action links, e.g. `https://habitify.pages.dev` |

Retired: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NTFY_TOPIC`.
Unchanged: `BREVO_API_KEY` / `MAILEROO_API_KEY`, `SENDER_EMAIL`, `SENDER_NAME`.

`ACTION_TOKEN_SECRET` was added later, by `docs/fcm-action-token-spec.md` — see that
spec for its purpose (signing the background-completion action tokens) and the new
`complete-habit` edge function that reads it.

---

## 5. Do NOT touch

- `supabase/functions/send-reminders/` — the email path, out of scope
- The `get_dashboard_data` / `get_widget_data` RPCs
- `habitify_widget/` — the Flutter widget app
- `src/lib/streaks.ts` — client streak math
- `build.sh`, `public/_redirects`, `tailwind.config.js`, `postcss.config.js`, ESLint/TS config
- Any live database, any deployed worker, any deployed edge function. This change is
  source-only; deployment is the operator's step.
- Do not add npm or Deno dependencies. `fetch` covers everything.

---

## 6. Acceptance

### Offline — the implementer runs these and iterates until they pass

```bash
npm run build     # tsc -b && vite build - must exit 0 with no TS errors
npm run lint      # must exit 0
```

Then these greps must all return **no matches**:

```bash
grep -rn "usePushNotifications\|pushNotifications\|NotificationSettings\|NtfySettings" src/
grep -rn "sw-push" vite.config.ts public/
grep -rn "notify_ntfy" src/ supabase/
grep -rn "ntfy\.sh" src/ supabase/functions/
grep -rn "VAPID\|webpush\|push_subscriptions" src/ vite.config.ts
```

And this must return exactly two files (the two converted functions):

```bash
grep -rln "_shared/notifier" supabase/functions/
```

### Live — operator step, document it, do not attempt it

1. Set the four secrets in section 4; deploy `send-ntfy-notifications` and
   `send-streak-reminders`.
2. Subscribe to the topic in CloudPush.
3. Smoke-test the worker directly:
   ```bash
   curl -X POST "$NOTIFIER_URL/push-fcm" -H "key: $NOTIFIER_API_KEY" \
     -H 'content-type: application/json' \
     -d '{"title":"Habitify","body":"test","fcm-topic":"habitify_<user>",
          "action":[{"url":"https://<app>/dashboard","label":"Open"}]}'
   ```
   Expect `200` and a CloudPush notification with one **Open** button.
4. End to end, reminder push: set a habit reminder for the next 5-minute slot, wait for
   cron, tap **Mark Complete**, confirm the habit shows completed and its streak
   increments.
5. End to end, streak push: with 2+ habits incomplete and one streak above 5 days, wait
   for the evening slot. Confirm three buttons arrive. **Full Complete** must tick every
   habit scheduled today; **Minimum Complete** must tick only the highest-streak one;
   tapping the notification **body** must tick nothing.
