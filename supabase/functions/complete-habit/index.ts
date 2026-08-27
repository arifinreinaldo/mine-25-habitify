// Token-authenticated habit completion, fired by a CloudPush notification action
// button (background POST) or by a human tapping the same link in a browser (GET,
// see the note in fcm-action-token-spec.md section 2.3).
//
// Deployment note: this function must be deployed with JWT verification OFF
// (`supabase/config.toml` sets `verify_jwt = false` for this function). Supabase's API
// gateway rejects requests with no `Authorization` header before this code ever runs,
// and a CloudPush background POST carries no Supabase JWT. The HMAC token in the `t`
// query param is the sole authentication — if `verify_jwt` reverts to true, every
// request 401s at the gateway before reaching this file, which looks exactly like a
// token bug. See fcm-action-token-spec.md section 5.2 / section 8 for how to confirm
// the gateway is actually letting requests through.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Signing is imported, never reimplemented: minting (mintActionToken) and verifying
// below must share one algorithm and one truncation length, or every live token 401s.
import { signActionPayload } from "../_shared/notifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface HabitRow {
  id: string;
  frequency_days: number[] | null;
}

interface TokenPayload {
  userId: string;
  target: string;
  date: string;
  exp: number;
}

function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) base64 += "=".repeat(4 - pad);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Constant-time string compare. Accumulates an XOR over every character and never
 *  early-returns on a mismatch, so response timing cannot leak which character (or
 *  how many) differed from the expected signature. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Verifies a token minted by mintActionToken (_shared/notifier.ts) against
 *  ACTION_TOKEN_SECRET. Never logs the token or the secret. */
async function verifyToken(
  token: string,
  secret: string,
): Promise<{ ok: true; payload: TokenPayload } | { ok: false }> {
  const sepIndex = token.lastIndexOf(".");
  if (sepIndex === -1) return { ok: false };

  const payloadPart = token.slice(0, sepIndex);
  const sigPart = token.slice(sepIndex + 1);

  let payload: string;
  try {
    payload = base64urlDecode(payloadPart);
  } catch {
    return { ok: false };
  }

  const expectedSig = await signActionPayload(secret, payload);

  if (!timingSafeEqual(sigPart, expectedSig)) {
    return { ok: false };
  }

  const parts = payload.split(".");
  if (parts.length !== 4) return { ok: false };

  const [userId, target, date, expStr] = parts;
  const exp = Number(expStr);
  if (!userId || !target || !date || !Number.isFinite(exp)) {
    return { ok: false };
  }

  return { ok: true, payload: { userId, target, date, exp } };
}

/** Day-of-week for a YYYY-MM-DD date string, independent of the server's local
 *  timezone (the edge runtime's local offset must not change which weekday a fixed
 *  calendar date resolves to). */
function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function jsonSuccess(message: string, data: unknown) {
  const requestId = crypto.randomUUID();
  return new Response(JSON.stringify({ message, data, request_id: requestId }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
  });
}

function jsonError(status: number, message: string) {
  const requestId = crypto.randomUUID();
  const retryable = status === 429 || status === 503;
  return new Response(
    JSON.stringify({ message, errors: null, retryable, request_id: requestId }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
      },
    },
  );
}

/** The receipt is the one HTML sink in this file. Every current caller passes a literal
 *  or an integer, but escaping here means adding a habit name to the copy later cannot
 *  turn into stored XSS on the functions origin. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlReceipt(status: number, rawTitle: string, rawBody: string) {
  const title = escapeHtml(rawTitle);
  const body = escapeHtml(rawBody);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin:0; padding:40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#1a1a2e; color:#fff; display:flex; justify-content:center; }
  .card { max-width:420px; text-align:center; background:#16213e; border-radius:16px; padding:32px 24px; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { color:#a0aec0; font-size:15px; line-height:1.5; margin:0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function respondSuccess(isGet: boolean, completed: number) {
  if (isGet) {
    const title = completed > 0 ? "All done!" : "Already up to date";
    const body = completed > 0
      ? `${completed} habit${completed === 1 ? "" : "s"} marked complete.`
      : "Nothing to do here — already completed.";
    return htmlReceipt(200, title, body);
  }
  return jsonSuccess("Completed", { completed });
}

function respondError(isGet: boolean, status: number, message: string) {
  if (isGet) {
    const title = status === 410 ? "Link expired" : "Something went wrong";
    return htmlReceipt(status, title, message);
  }
  return jsonError(status, message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const isGet = req.method === "GET";

  // Only GET and POST redeem a token. Without this, HEAD/PUT/DELETE fall through to the
  // write path - a link scanner or proxy prefetch issuing HEAD would silently complete
  // the habit.
  if (!isGet && req.method !== "POST") {
    return respondError(isGet, 405, "Method not allowed");
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("t");

  if (!token) {
    return respondError(isGet, 400, "Missing token");
  }

  const secret = Deno.env.get("ACTION_TOKEN_SECRET");
  if (!secret) {
    console.error("ACTION_TOKEN_SECRET is not configured");
    return respondError(isGet, 500, "Server misconfigured");
  }

  const verified = await verifyToken(token, secret);
  if (!verified.ok) {
    return respondError(isGet, 401, "Invalid token");
  }

  const { userId, target, date, exp } = verified.payload;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp < nowSeconds) {
    return respondError(isGet, 410, "This link has expired.");
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // Service-role client: bypasses RLS. Every query below scopes by userId itself —
    // that scoping is the only thing standing between this token and someone else's data.
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let habitsToComplete: HabitRow[];

    if (target === "all") {
      const { data: habits, error: habitsError } = await supabase
        .from("habits")
        .select("id, frequency_days")
        .eq("user_id", userId)
        .eq("is_archived", false);

      if (habitsError) {
        console.error("complete-habit habits query error:", habitsError.message);
        return respondError(isGet, 500, "Could not load habits");
      }

      // date comes from the token, not the clock - a reminder sent at 23:58 and
      // tapped at 00:03 must still complete the day it was sent for.
      const dow = dayOfWeek(date);
      habitsToComplete = ((habits ?? []) as HabitRow[]).filter((h) => {
        if (!h.frequency_days || h.frequency_days.length === 0) return true;
        return h.frequency_days.some((d) => Number(d) === dow);
      });
    } else {
      // Never trust a habit id alone: the token binds the (userId, target) pair, and
      // this query enforces that pairing too, not just the token's signature.
      const { data: habit, error: habitError } = await supabase
        .from("habits")
        .select("id, frequency_days")
        .eq("id", target)
        .eq("user_id", userId)
        .maybeSingle();

      if (habitError) {
        console.error("complete-habit habit query error:", habitError.message);
        return respondError(isGet, 500, "Could not load habit");
      }

      if (!habit) {
        return respondError(isGet, 404, "Habit not found");
      }

      habitsToComplete = [habit as HabitRow];
    }

    if (habitsToComplete.length === 0) {
      return respondSuccess(isGet, 0);
    }

    // completions has UNIQUE(habit_id, completed_at) - a bulk insert fails entirely on
    // one duplicate row, so already-completed habits must be filtered out first.
    const habitIds = habitsToComplete.map((h) => h.id);
    const { data: existing, error: existingError } = await supabase
      .from("completions")
      .select("habit_id")
      .eq("user_id", userId)
      .eq("completed_at", date)
      .in("habit_id", habitIds);

    if (existingError) {
      console.error("complete-habit completions query error:", existingError.message);
      return respondError(isGet, 500, "Could not check existing completions");
    }

    const alreadyCompleted = new Set(
      (existing ?? []).map((c: { habit_id: string }) => c.habit_id),
    );
    const toInsert = habitsToComplete.filter((h) => !alreadyCompleted.has(h.id));

    if (toInsert.length > 0) {
      // upsert, not insert: the select above is a read-then-write race. Double-tapping
      // "Mark Complete" fires two broadcasts ~200ms apart, both see no existing row, and
      // the loser gets 23505 - reported to the user as "Couldn't reach Habitify" on a
      // habit that did complete. ignoreDuplicates makes redemption genuinely idempotent.
      const { error: insertError } = await supabase.from("completions").upsert(
        toInsert.map((h) => ({
          habit_id: h.id,
          user_id: userId,
          completed_at: date,
          value: 1,
        })),
        { onConflict: "habit_id,completed_at", ignoreDuplicates: true },
      );

      if (insertError) {
        console.error("complete-habit insert error:", insertError.message);
        return respondError(isGet, 500, "Could not save completion");
      }
    }

    // Idempotent by construction: an already-complete habit yields completed: 0, a
    // success, never an error.
    return respondSuccess(isGet, toInsert.length);
  } catch (error) {
    console.error("complete-habit error:", error instanceof Error ? error.message : error);
    return respondError(isGet, 500, "Unexpected error");
  }
});
