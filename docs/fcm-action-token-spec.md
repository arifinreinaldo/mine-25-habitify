# Spec — Background action tokens: complete a habit without opening the app

Tapping **Mark Complete** / **Full Complete** / **Minimum Complete** on a CloudPush
notification must write the completion and open nothing. Today those buttons are
`ACTION_VIEW` intents that launch the Habitify PWA in a browser.

Three repositories change. The contract between them is fixed in section 2 and must be
implemented identically on both sides.

The reader of this spec has no conversation context. Every contract detail is here.

Builds on `docs/fcm-push-spec.md` (already implemented). Read that first for how the push
pipeline currently works — this spec only describes the delta.

---

## 1. Why each repo changes

| Repo | Path | Change |
|---|---|---|
| cloudflare-notifier | `C:\Users\Reinaldo\Backend\cloudflare_notifier` | `action` entries gain an optional `method` field so an action can say "POST me in the background" instead of "open me" |
| cloudpush-android | `C:\Users\Reinaldo\AndroidStudioProjects\cloudpush-android` | Honour `method: "POST"` — fire the request from a `BroadcastReceiver` instead of launching a browser |
| mine-25-habitify | `C:\Users\Reinaldo\Backend\mine-25-habitify` | New token-authenticated edge function that performs the completion; senders mint signed tokens and mark those actions `POST` |

The worker currently **drops** unknown keys: `parseActions` (`src/index.js:247-263`) builds
a fresh `{url, label}` object per entry. `method` therefore cannot reach the phone until
the worker is changed. Do not skip the worker change and hope it passes through.

---

## 2. The wire contract (implement identically in all three repos)

### 2.1 Action object

```json
{ "url": "https://...", "label": "Mark Complete", "method": "POST" }
```

- `method` is **optional**. Absent or `"GET"` → existing behaviour, an `ACTION_VIEW` link.
- `"POST"` → the receiving app performs a background HTTP POST and opens nothing.
- Case-insensitive on input, normalised to uppercase before it goes on the wire.
- Only `GET` and `POST` are legal. Anything else is a 422 from the worker.
- The `label|url` string form **cannot** express `method` — there is no delimiter for it.
  Callers needing `method` must use the JSON object form. Document this; do not invent a
  third delimiter.

### 2.2 Token

Opaque to the worker and to CloudPush. Both treat it as part of the URL. Only Habitify
mints and verifies it.

```
payload = "<userId>.<target>.<date>.<exp>"
    userId  UUID of the habit owner
    target  a habit UUID, or the literal string "all"
    date    YYYY-MM-DD, the day the completion is written for
    exp     Unix seconds, mint time + 24h

token   = base64url(payload) + "." + base64url(HMAC_SHA256(ACTION_TOKEN_SECRET, payload)).slice(0, 22)
```

base64url = standard base64 with `+`→`-`, `/`→`_`, `=` padding stripped.

The signature is truncated to 22 base64url chars (132 bits). That is far beyond forgeable
for this threat model and keeps the URL short.

`date` is baked in at mint time, **not** read from the clock at redemption. A reminder
sent at 23:58 and tapped at 00:03 must still complete the day it was sent for.

### 2.3 Endpoint

```
POST {SUPABASE_URL}/functions/v1/complete-habit    Authorization: Bearer <token>
GET  {SUPABASE_URL}/functions/v1/complete-habit?t=<token>
```

Both methods are supported and do the same work. They differ in how the token arrives
and in the response body:

| Method | Caller | Token carrier | Response |
|---|---|---|---|
| `POST` | CloudPush background action | `Authorization: Bearer` | `200` JSON `{message, data:{completed:<int>}}` |
| `GET` | a human opening the URL in a browser | `?t=` query param | `200` plain-text receipt |

The bearer is the primary carrier, per `cloudflare_notifier/docs/cloudpush-action-spec.md`
section 2.3. A URL never carries the token to CloudPush any more: the edge gateway logs
request URLs, and this token completes habits. `?t=` stays accepted on **both** methods —
it is the only carrier a browser address bar has, and tokens minted before the change
keep working for their full 24h TTL. `complete-habit` reads the bearer first and falls
back to the query param.

`GET` exists because CloudPush's Detail screen renders every action URL as a tappable
link chip (`ui/components/LinkToken.kt:57`), so a background action's URL **will** be
opened in a browser sooner or later. Returning `405` there would look broken.

Both are idempotent: completing an already-complete habit is a success with
`completed: 0`, never an error.

---

## 3. cloudflare-notifier changes

Repo rules live in that repo's `CLAUDE.md` — read it. Both test layers must pass before
this is done.

### 3.1 `src/index.js`

**`parseActions` (line 247)** — preserve `method` from the object form:

```js
if (typeof item === 'object') {
  const label = String(item.label ?? '').trim();
  const method = String(item.method ?? '').trim().toUpperCase();
  return { url: String(item.url ?? '').trim(), ...(label && { label }), ...(method && { method }) };
}
```

The string branch is unchanged — a `label|url` string never carries a method.

**`actionError` (line 266)** — add one rule, keeping the existing return-first-error shape:

```js
const badMethod = actions.filter((a) => a.method && a.method !== 'GET' && a.method !== 'POST');
if (badMethod.length) return `method must be GET or POST`;
```

This is shared by `/push` and `/push-fcm`, which is correct — both should validate it.

### 3.2 `src/fcm.js`

No change needed: `data.actions = JSON.stringify(actions)` (line 34) already serialises
whatever `parseActions` produced, so `method` rides along. **Verify this by reading it;
do not add a second serialisation path.**

### 3.3 `src/channels.js` (ntfy)

The ntfy channel turns actions into ntfy buttons, which are view-only. A `POST` action
sent to ntfy has no meaningful rendering. Leave the ntfy channel **unchanged** — it keeps
ignoring `method` and rendering a link. ntfy is deferred in production anyway (see that
repo's `CLAUDE.md`). Do not attempt an ntfy `http` action mapping.

### 3.4 `test.mjs`

New tests, existing ones untouched and passing:

1. `method: "post"` in a JSON action is normalised to `"POST"` in the FCM `data.actions`
2. `method: "PATCH"` → 422 with `errors.action` mentioning method
3. an action with no `method` still produces `data.actions` entries with no `method` key
4. a `label|url` string action is unaffected

### 3.5 `postman/CloudPush.postman_collection.json`

Per that repo's rules, a new field lands in the collection in the same change, with an
assertion. Add one `/push-fcm` scenario sending a `method: "POST"` action and asserting
`200`, plus one asserting `422` for an invalid method.

### 3.6 `README.md`

Document `method` in both action tables (`/push` and `/push-fcm`), including that the
string form cannot express it.

### 3.7 Verification (both required)

```
npm test
npm run test:postman     # needs the worker running - serve-local.bat, own terminal
```

`wrangler` needs Node >= 22 and the machine defaults to Node 20 — `nvm use 23.8.0` first,
or use `serve-local.bat` which checks for you. Kill leftover listeners on 8787/8788 first.

**Do not deploy the worker.** Source and local tests only.

---

## 4. cloudpush-android changes

`applicationId com.rei.cloudpush`. Kotlin, Compose, Hilt, Room. **Add no new dependency** —
`HttpURLConnection` from `java.net` covers the HTTP call and `INTERNET` is already granted
(`AndroidManifest.xml:5`).

### 4.1 `push/PushPayload.kt`

```kotlin
data class PushAction(
    val url: String,
    val providedLabel: String? = null,
    val method: String? = null,
) {
    val label: String
        get() = providedLabel ?: runCatching { java.net.URI(url).host }.getOrNull() ?: url

    /** True when this action fires an HTTP POST in the background instead of opening a browser. */
    val isBackground: Boolean get() = method == "POST"
}
```

### 4.2 `push/PushMessageParser.kt`

Extract `method` per object chunk, exactly the way `label` is extracted today
(`labelFieldRegex`, line 44, applied within each chunk). Add a `methodFieldRegex`
alongside it and pass the value into `PushAction`.

Uppercase and trim it. Treat any value other than `POST` as null — an unknown method must
degrade to a normal link, never to a dropped button. Follow the file's existing rule that
a malformed actions payload still shows the notification.

### 4.3 NEW — `service/ActionReceiver.kt`

A `BroadcastReceiver` that performs the POST off the main thread.

```kotlin
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { /* goAsync() + POST */ }
}
```

- Extras: the action URL (`String`) and the notification id (`Int`).
- Use `goAsync()` and run the request on `Dispatchers.IO`, calling `finish()` in a
  `finally`. `goAsync()` allows roughly 10 seconds — set `connectTimeout` and
  `readTimeout` to 8000 ms so the call cannot outlive its window.
- `HttpURLConnection`, `requestMethod = "POST"`, `doOutput = false`, no body,
  `setFixedLengthStreamingMode(0)`.
- 2xx → success. Anything else, or an exception → failure.
- **Success:** cancel the notification (`NotificationManager.cancel(notificationId)`).
- **Failure:** re-post the same notification id with the body text replaced by a short
  failure line (for example `"Couldn't reach Habitify — tap to open"`) and its
  `contentIntent` left as the existing open-app intent. Silent failure is the specific
  thing this feature must not do.
- `ponytail:` comment noting the ceiling: one attempt, no retry queue. WorkManager is the
  upgrade path if offline taps need to survive.

Register it in `AndroidManifest.xml` with `android:exported="false"`.

### 4.4 `service/NotificationHelper.kt`

At the `payload.actions.take(3).forEachIndexed` loop (line ~79), branch:

```kotlin
val pending = if (action.isBackground) {
    backgroundIntent(context, action.url, notificationId, actionRequestCode)
} else {
    viewIntent(context, action.url, actionRequestCode)
}
builder.addAction(0, action.label, pending)
```

`backgroundIntent` is a new private function using `PendingIntent.getBroadcast` with an
**explicit** `Intent(context, ActionReceiver::class.java)` and `FLAG_IMMUTABLE`, matching
the existing `viewIntent` style. Distinct `requestCode` per action is already handled by
`actionRequestCode`.

Change nothing else in this file. `setContentIntent(tapIntent)` stays `openAppIntent` —
the notification body tap must keep opening the app, not fire an action.

### 4.5 `ui/components/LinkToken.kt` and `ui/detail/DetailScreen.kt`

Leave both unchanged. A background action still appears as a link chip in Detail, and
tapping it opens the URL in a browser — which is exactly why the endpoint answers `GET`
with an HTML receipt (section 2.3).

### 4.6 Tests

`app/src/test/java` — JUnit, no instrumentation. Add parser tests:

1. `{"url":"https://x/y","label":"Do","method":"POST"}` → `isBackground == true`
2. `method` absent → `isBackground == false`
3. `"method":"post"` (lowercase) → normalised, `isBackground == true`
4. `"method":"DELETE"` → `isBackground == false`, button still present with its label
5. a mixed array where only the second entry has `method` → the method lands on the
   correct entry (the existing per-chunk pairing rule, `PushMessageParser.kt:34-39`)

### 4.7 Verification

```
gradlew.bat test
```

Must pass. **Do not** run a release build, do not sign anything, do not install to a
device, do not touch `google-services.json`.

---

## 5. mine-25-habitify changes

### 5.1 NEW — `supabase/functions/complete-habit/index.ts`

Handles both `GET` and `POST` (plus `OPTIONS` for CORS, matching the other functions).

**Deployment note for the operator, state it in a header comment:** this function runs
with JWT verification **off** — see 5.2. Supabase's API gateway rejects requests with no
`Authorization` header *before* function code runs, and a CloudPush background POST
carries no Supabase JWT. The HMAC token is the sole authentication. Getting this wrong
produces a 401 that looks exactly like a token bug.

Flow:

1. Read `t` from the query string. Missing → 400.
2. Verify: split on the last `.`, base64url-decode the payload, recompute
   HMAC-SHA256 with `ACTION_TOKEN_SECRET` via `crypto.subtle`, compare the truncated
   signature in **constant time** (compare full-length strings, accumulate an XOR of char
   codes — do not early-return on first mismatch). Mismatch → 401.
3. Parse `userId`, `target`, `date`, `exp`. `exp` in the past → 410 Gone.
4. Build a service-role Supabase client (`SUPABASE_SERVICE_ROLE_KEY`). This bypasses RLS,
   which is why no user session is needed — and why step 5 must scope every query by
   `userId` itself.
5. Resolve the habits to complete:
   - `target === "all"` → select the user's non-archived habits, then keep those scheduled
     on `date`'s day-of-week using the same `frequency_days` rule the senders use
     (`h.frequency_days` empty/absent → always scheduled; otherwise
     `frequency_days.some(d => Number(d) === dow)`).
   - otherwise → select that one habit **filtered by `.eq("user_id", userId)`**. Not found
     → 404. Never insert on a habit id alone; the token binds the pair, and the query must
     enforce it too.
6. Drop habits already completed on `date` (select `completions` for those habit ids and
   that date). `completions` has `UNIQUE(habit_id, completed_at)` and a bulk insert fails
   entirely on one duplicate row.
7. Insert the remainder as `{habit_id, user_id: userId, completed_at: date, value: 1}`.
   `value: 1` matches `handleToggleHabit` (`src/pages/Dashboard.tsx:236`).
8. Respond per section 2.3. On `GET`, the HTML must be self-contained — no external CSS,
   no fonts, no scripts — and state what happened: how many habits were completed, or
   that they were already done, or that the link expired.

Never log the token or `ACTION_TOKEN_SECRET`.

### 5.2 NEW — `supabase/config.toml`

This repo has **no** `supabase/config.toml` today. Create it with exactly this content:

```toml
project_id = "mine25-habitify"

[functions.complete-habit]
verify_jwt = false
```

Why a committed file rather than the `--no-verify-jwt` deploy flag: the flag is per-deploy.
The next plain `supabase functions deploy complete-habit` silently turns JWT verification
back on and every action button starts returning 401. The config file makes it a property
of the repository instead of something the operator has to remember at the terminal.

Verified against the installed CLI (2.72.8): this exact 4-line file parses, `project_id`
is consumed, and the `[functions.complete-habit]` block is accepted without a schema
error. **Not** verified: that the deploy path honours it, which needs a real deploy. So
the operator still passes `--no-verify-jwt` on the *first* deploy and confirms with the
curl in section 8; after that the config file carries it.

Do not run `supabase init` — it generates ~350 lines of local-dev defaults this project
does not use. Hand-write the four lines above.

### 5.3 `supabase/functions/_shared/notifier.ts`

Add:

```ts
/** Signs "<userId>.<target>.<date>.<exp>" per the spec's section 2.2. target is a habit
 *  UUID or the literal "all". */
export function mintActionToken(
  secret: string,
  opts: { userId: string; target: string; date: string; ttlSeconds?: number },
): Promise<string>;

/** {SUPABASE_URL}/functions/v1/complete-habit - the token rides in the action's
 *  Authorization header, never in this URL. */
export function completeUrl(supabaseUrl: string): string;

/** Reads `Authorization: Bearer <token>`; "" when absent or not a bearer. */
export function bearerToken(authHeader: string | null): string;
```

`ttlSeconds` defaults to 86400 (24h). Use `crypto.subtle.importKey('raw', …, {name:'HMAC',
hash:'SHA-256'}, false, ['sign'])` and `crypto.subtle.sign`.

Change the two action builders so the completing entries are background POSTs:

```ts
export function reminderActions(appUrl: string, completeUrl: string): PushAction[] {
  return [
    { url: `${appUrl}/dashboard`, label: "Open Reminder" },
    { url: completeUrl, label: "Mark Complete", method: "POST" },
  ];
}

export function streakActions(appUrl: string, allUrl: string, minimumUrl: string): PushAction[] {
  return [
    { url: `${appUrl}/dashboard`, label: "Open Reminder" },
    { url: allUrl, label: "Full Complete", method: "POST" },
    { url: minimumUrl, label: "Minimum Complete", method: "POST" },
  ];
}
```

`Open Reminder` stays a plain link with no `method` — it is meant to open the app.

Add `method?: string` to the `PushAction` interface.

### 5.4 `supabase/functions/send-ntfy-notifications/index.ts`

Read `ACTION_TOKEN_SECRET` and guard it the way `FCM_TOPIC_PREFIX` and `APP_URL` are
guarded (throw when missing). Mint a token with `target = habit.id` and
`date = today` — the function already computes `today` in the user's timezone; use that
exact variable, not a fresh date. Pass `completeUrl(...)` into `reminderActions`.

### 5.5 `supabase/functions/send-streak-reminders/index.ts`

Same secret guard. Mint **two** tokens per user: one with `target = "all"`, one with
`target = habitWithMaxStreak.id`. Both use the function's existing `today` (user's
timezone). Pass both URLs into `streakActions`.

### 5.6 `src/pages/Dashboard.tsx`

**Leave the `?complete=` handler in place, unchanged.** After this change nothing emits
that URL any more, so it is unused — but it is a working fallback if an action ever needs
to point back at the app, and removing it is not part of this task. Add a one-line comment
above it saying it is currently unused and why it is kept.

### 5.7 `.env.example` and `docs/fcm-push-spec.md`

No `VITE_` variable changes — the token never reaches the browser bundle. Add a note to
section 4 of `fcm-push-spec.md` pointing at this spec for the two new secrets.

### 5.8 `CLAUDE.md`

Add `ACTION_TOKEN_SECRET` to the secrets list and describe `complete-habit` in the
notifications section — including that it runs with `verify_jwt = false` via
`supabase/config.toml`, why (the HMAC token is the auth, the caller has no Supabase JWT),
and that a gateway 401 is the symptom when that setting is lost.

### 5.9 Verification

```
npm run build     # must exit 0
npx eslint supabase/functions/ src/pages/Dashboard.tsx    # must exit 0 for changed files
```

Repo-wide `npm run lint` is **already red** with 11 pre-existing errors unrelated to this
work (see `fcm-push-spec.md`). Do not fix them; only confirm you added none.

---

## 6. New secrets (operator sets these — implementer only reads them)

| Name | Where | Purpose |
|---|---|---|
| `ACTION_TOKEN_SECRET` | Supabase | HMAC key for action tokens. Generate with `openssl rand -base64 32` |

Existing and unchanged: `NOTIFIER_URL`, `NOTIFIER_API_KEY`, `FCM_TOPIC_PREFIX`, `APP_URL`.

---

## 7. Do NOT touch

- `supabase/functions/send-reminders/` — the email sender, out of scope
- `habitify_widget/`
- The ntfy channel in `cloudflare_notifier/src/channels.js`
- `cloudpush-android` UI screens beyond what section 4.4 names, and never
  `google-services.json`, signing config, or release build settings
- Any deployment: no `wrangler deploy`, no `supabase functions deploy`, no APK install.
  All three repos are source-and-local-tests only.
- No new npm, Deno, or Gradle dependencies anywhere.
- No git commits in any repo.

---

## 8. Acceptance

### Per repo, offline

| Repo | Command | Requirement |
|---|---|---|
| cloudflare_notifier | `npm test` | pass, including the 4 new tests |
| cloudflare_notifier | `npm run test:postman` | pass, including the 2 new scenarios |
| cloudpush-android | `gradlew.bat test` | pass, including the 5 new parser tests |
| mine-25-habitify | `npm run build` | exit 0 |
| mine-25-habitify | `npx eslint` on changed files | exit 0 |

### Cross-repo contract check

Grep all three for the literal `"POST"` action method and confirm one shared shape:
the worker normalises and validates it, CloudPush reads it into `isBackground`, Habitify
emits it on exactly the three completing actions and never on `Open Reminder`.

### Live — operator step, document it, do not attempt it

1. `supabase secrets set ACTION_TOKEN_SECRET=...`
2. `supabase functions deploy complete-habit --no-verify-jwt`, then redeploy
   `send-ntfy-notifications` and `send-streak-reminders`.

   Confirm the gateway is actually letting unauthenticated requests through before
   blaming the token — this must NOT return 401:

   ```bash
   curl -i -X POST "$SUPABASE_URL/functions/v1/complete-habit?t=bogus"
   curl -i -X POST "$SUPABASE_URL/functions/v1/complete-habit" -H "Authorization: Bearer bogus"
   ```

   Expect `401` **from our own handler** with a JSON body naming a bad token, or `400`
   for a malformed one — not the gateway's bare `{"code":401,"message":"Missing
   authorization header"}`. The two are easy to confuse; the body tells them apart.

   Run the second curl too. It is the shape CloudPush actually sends, and it is the one
   new failure mode: the gateway must forward a non-JWT bearer untouched. A gateway
   `{"code":401,"message":"Invalid JWT"}` there means `verify_jwt = false` is not in
   force, not that the token is wrong.

   Then redeploy once more **without** the flag and re-run the same curl, to prove
   `supabase/config.toml` is carrying the setting on its own. If it comes back as the
   gateway 401, the config file is not being honoured by this CLI version — keep the flag
   on every deploy and note it in `CLAUDE.md`.
3. `wrangler deploy` the worker
4. Build and install CloudPush
5. Mint a token by triggering a reminder, then verify:
   - Tapping **Mark Complete** opens **nothing** and the notification disappears
   - The habit shows complete in the PWA on next load
   - Tapping the same action again is a no-op, not an error
   - Opening the action URL in a browser shows the HTML receipt
   - A tampered token returns 401
