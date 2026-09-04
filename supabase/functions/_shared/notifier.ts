// Shared FCM push helper for edge functions. Sends through the cloudflare-notifier
// worker's POST /push-fcm endpoint. Bundled into each function that imports it —
// this file is not deployed on its own.

export interface PushAction {
  url: string;
  label?: string;
  method?: string;
  /** Bearer credential for a background action. The worker sends it as
   *  `Authorization: Bearer <token>`, never in the URL - see
   *  cloudflare_notifier/docs/cloudpush-action-spec.md section 2.3. */
  token?: string;
}

// The per-user FCM topic is NOT derived here any more. It lives in profiles.push_topic,
// generated randomly by the database, because the push payload carries a completion
// token: anyone who can guess the topic and subscribe to it in CloudPush receives a
// working credential for that user's habits. Senders read the column and skip a user
// who has none.

/** Returns true when the worker answered 2xx. Logs and returns false otherwise —
 *  never throws, so one bad push cannot kill the batch. */
export async function pushFcm(opts: {
  title: string;
  body: string;
  topic: string;
  actions?: PushAction[];
}): Promise<boolean> {
  const notifierUrl = Deno.env.get("NOTIFIER_URL");
  const notifierApiKey = Deno.env.get("NOTIFIER_API_KEY");

  if (!notifierUrl || !notifierApiKey) {
    console.error("NOTIFIER_URL or NOTIFIER_API_KEY is not configured");
    return false;
  }

  const url = `${notifierUrl.replace(/\/+$/, "")}/push-fcm`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        key: notifierApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        "fcm-topic": opts.topic,
        action: opts.actions ?? [],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      console.error(`push-fcm error: ${response.status} ${text}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("push-fcm error:", error);
    return false;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/** Truncated length of an action token signature, in base64url chars (132 bits). */
const ACTION_SIG_LENGTH = 22;

/** The signature half of an action token. Both the minter below and the verifier in
 *  complete-habit/index.ts call THIS function - never their own copy. Sharing it is the
 *  point: if the algorithm or the truncation length drifted between the two sides, every
 *  live token would start failing with an indistinguishable 401. */
export async function signActionPayload(secret: string, payload: string): Promise<string> {
  const signatureBytes = await hmacSha256(secret, payload);
  return base64url(signatureBytes).slice(0, ACTION_SIG_LENGTH);
}

/** Signs "<userId>.<target>.<date>.<exp>" per fcm-action-token-spec.md section 2.2.
 *  target is a habit UUID or the literal "all". Never log the returned token or the
 *  secret. */
export async function mintActionToken(
  secret: string,
  opts: { userId: string; target: string; date: string; ttlSeconds?: number },
): Promise<string> {
  const ttlSeconds = opts.ttlSeconds ?? 86400;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${opts.userId}.${opts.target}.${opts.date}.${exp}`;
  const payloadB64 = base64url(new TextEncoder().encode(payload));
  return `${payloadB64}.${await signActionPayload(secret, payload)}`;
}

/** The action token as CloudPush sends it on a background request:
 *  `Authorization: Bearer <token>` (cloudpush-action-spec.md section 2.3). Returns ""
 *  when the header is absent or is not a bearer, so the caller can fall back to `?t=`.
 *  complete-habit calls THIS - a second copy of the prefix arithmetic is one off-by-one
 *  away from silently reading a truncated token and 401ing every action. */
export function bearerToken(authHeader: string | null): string {
  const header = authHeader ?? "";
  return /^bearer /i.test(header) ? header.slice(7).trim() : "";
}

/** {SUPABASE_URL}/functions/v1/complete-habit - no token in the URL. The action token
 *  rides in the Authorization header (PushAction.token), so it stays out of the edge
 *  gateway's access logs and out of any browser history. */
export function completeUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/complete-habit`;
}

/** Reminder push (one specific habit): [Open Reminder, Mark Complete]. Mark Complete is
 *  a background POST - CloudPush fires it from the shade with the bearer token and opens
 *  nothing. token comes from mintActionToken and binds this habit and this date. */
export function reminderActions(
  appUrl: string,
  completeUrl: string,
  token: string,
): PushAction[] {
  return [
    { url: `${appUrl}/dashboard`, label: "Open Reminder" },
    { url: completeUrl, label: "Mark Complete", method: "POST", token },
  ];
}

/** Streak push (N incomplete habits): [Open Reminder, Full Complete, Minimum Complete].
 *  Both background POSTs hit the same URL and differ only by token - allToken targets
 *  "all", minimumToken the single highest-streak habit. CloudPush treats the background
 *  actions of one push as alternatives: the first one to succeed disables the other. */
export function streakActions(
  appUrl: string,
  completeUrl: string,
  allToken: string,
  minimumToken: string,
): PushAction[] {
  return [
    { url: `${appUrl}/dashboard`, label: "Open Reminder" },
    { url: completeUrl, label: "Full Complete", method: "POST", token: allToken },
    { url: completeUrl, label: "Minimum Complete", method: "POST", token: minimumToken },
  ];
}
