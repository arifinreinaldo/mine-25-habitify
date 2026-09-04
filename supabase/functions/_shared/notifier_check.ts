// Self-check for the notification action contract. Run: deno run supabase/functions/_shared/notifier_check.ts
//
// It guards the four properties that fail silently in production. A bad token charset
// or an over-budget action set makes the cloudflare-notifier worker answer 422 and the
// push never leaves; a token left in the URL leaks a completion credential into the
// edge gateway's access log; a wrong bearer prefix 401s every action button.
// Contract: cloudflare_notifier/docs/cloudpush-action-spec.md sections 2.1 and 2.3.

import assert from "node:assert";
import {
  bearerToken,
  completeUrl,
  mintActionToken,
  type PushAction,
  reminderActions,
  streakActions,
} from "./notifier.ts";

// Worker-side rules, copied from cloudpush-action-spec.md section 2.1. These are the
// remote validator's constants - this file must fail when we drift out of them.
const TOKEN_RE = /^[\x21-\x7E]{1,512}$/;
const MAX_RESERVED_BYTES = 3000;

const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const APP_URL = "https://habitify.example";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const HABIT_ID = "66666666-7777-8888-9999-000000000000";

function checkActions(name: string, actions: PushAction[]) {
  for (const action of actions) {
    assert.ok(!action.url.includes("?t="), `${name}: token left in the URL: ${action.url}`);

    if (!action.token) {
      assert.ok(!action.method, `${name}: "${action.label}" has a method but no token`);
      continue;
    }

    assert.equal(action.method, "POST", `${name}: "${action.label}" is not a background POST`);
    assert.ok(
      action.url.startsWith("https://"),
      `${name}: "${action.label}" carries a bearer over ${action.url}`,
    );
    assert.match(action.token, TOKEN_RE, `${name}: "${action.label}" token charset/length`);
  }

  // reservedBytes() in the worker measures the serialised action array.
  const bytes = new TextEncoder().encode(JSON.stringify(actions)).length;
  assert.ok(bytes <= MAX_RESERVED_BYTES, `${name}: ${bytes} bytes exceeds the 3000-byte budget`);
}

const secret = "test-secret";
const date = "2026-09-04";
const url = completeUrl(SUPABASE_URL);

const habitToken = await mintActionToken(secret, { userId: USER_ID, target: HABIT_ID, date });
const allToken = await mintActionToken(secret, { userId: USER_ID, target: "all", date });

const reminder = reminderActions(APP_URL, url, habitToken);
const streak = streakActions(APP_URL, url, allToken, habitToken);

checkActions("reminder", reminder);
checkActions("streak", streak);

// One completing button on a reminder, two alternatives on a streak push.
assert.equal(reminder.filter((a) => a.token).length, 1);
assert.equal(streak.filter((a) => a.token).length, 2);
// data.click needs a link action to fall back to, or tapping the notification body
// does nothing (cloudpush-action-spec.md section 2.2).
assert.ok(reminder.some((a) => !a.method) && streak.some((a) => !a.method));

// What complete-habit reads off the wire must be exactly what was minted.
assert.equal(bearerToken(`Bearer ${habitToken}`), habitToken);
assert.equal(bearerToken(`bearer ${habitToken} `), habitToken);
assert.equal(bearerToken(null), "");
assert.equal(bearerToken(`Basic ${habitToken}`), "");
assert.equal(bearerToken("Bearer"), "");

console.log("notifier_check: ok");
