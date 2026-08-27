import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { userTopic, pushFcm, streakActions, mintActionToken, completeUrl } from "../_shared/notifier.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Duolingo-style passive-aggressive streak reminder messages
const streakMessages = [
  // Guilt-trip messages
  "Your {streak} day streak is about to die. But hey, no pressure. It's not like you worked hard for it or anything.",
  "Hi, it's your {streak} day streak. I'm scared. Please don't let me die today.",
  "That beautiful {streak} day streak? Yeah, it's on life support. Just thought you should know.",
  "{streak} days of dedication. All about to vanish. Into the void. Forever. No big deal.",
  "Your streak called. It said 'Why have you forsaken me?' I didn't know what to say.",

  // Disappointed parent energy
  "I'm not mad about your {streak} day streak ending. I'm just... disappointed.",
  "Your {streak} day streak believed in you. It really did. *sighs heavily*",
  "Remember when you started that streak {streak} days ago? You were so hopeful. So young. So naive.",
  "Your streak is giving me 'forgotten at school pickup' vibes. Just saying.",

  // Dramatic threats
  "Complete your habit or the streak gets it. You have until midnight. Choose wisely.",
  "{streak} days. Gone. Reduced to atoms. Unless you act now.",
  "Your streak's last words were 'Tell them... I believed in them.' Sad, really.",
  "BREAKING: Local streak found crying in corner. Reportedly 'losing hope.' More at 11.",

  // Petty observations
  "Oh, you have time to scroll social media but not to keep your {streak} day streak alive? Interesting.",
  "Saw you were online earlier. Your streak saw too. It's trying to process.",
  "Your streak of {streak} days: 'Am I a joke to you?' Honestly, valid question.",

  // Passive-aggressive concern
  "Just checking in! Your {streak} day streak is fine. Totally fine. *nervous laughter* Everything is fine.",
  "No rush, but your streak is slowly withering away. Take your time though. It's fine. This is fine.",
  "Your {streak} day streak wanted me to tell you it still loves you. Even though you clearly don't care.",
  "Fun fact: Your streak will reset to 0 if you don't complete your habit. Fun, right? ...Right?",

  // Duo the owl energy
  "Beg.",
  "Spanish or vanish. Wait, wrong app. But the energy is the same. Do your habit.",
  "I know where you live. Do your habit. Keep your {streak} day streak alive.",
  "Your {streak} day streak and I are worried about you. Please respond.",
  "This is your final warning. The streak. Save it.",

  // Existential dread
  "What is a streak but proof that you once cared? Don't let {streak} days of caring die.",
  "In the grand scheme of the universe, your streak means nothing. But to you? It should mean everything.",
  "Time is an illusion. Your streak ending at midnight? Very much real.",

  // Sarcasm
  "Oh cool, you're just going to let {streak} days of work disappear. Very chill of you.",
  "Absolutely love watching streaks die. Said no one ever. Please complete your habit.",
  "Your {streak} day streak: exists. You: ignoring it. Me: taking notes.",
];

// Messages for users with multiple incomplete habits
const multiHabitMessages = [
  "You have {count} habits feeling neglected today. Your {streak} day streak is getting nervous.",
  "{count} incomplete habits. One dying streak. Zero excuses. The math isn't mathing.",
  "Your {count} habits are having a support group meeting about you. Topic: abandonment issues.",
  "Plot twist: You have {count} habits to complete and your streak of {streak} days is judging you.",
  "Not to be dramatic, but {count} habits are incomplete and your streak might not survive the night.",
];

// Messages when streak is at risk of dying today
const urgentMessages = [
  "FINAL NOTICE: Your {streak} day streak expires in a few hours. This is not a drill.",
  "Your streak is typing... Your streak has left the chat. (Unless you complete your habit NOW)",
  "If your {streak} day streak had a face, it would be making the disappointed emoji right now.",
  "T-minus a few hours until your streak becomes a cautionary tale. Act accordingly.",
  "Your streak's obituary is being drafted as we speak. Only you can stop this.",
];

function getRandomMessage(streak: number, incompleteCount: number, isUrgent: boolean): string {
  let messages: string[];

  if (isUrgent && Math.random() > 0.5) {
    messages = urgentMessages;
  } else if (incompleteCount > 1 && Math.random() > 0.6) {
    messages = multiHabitMessages;
  } else {
    messages = streakMessages;
  }

  const randomIndex = Math.floor(Math.random() * messages.length);
  return messages[randomIndex]
    .replace(/{streak}/g, streak.toString())
    .replace(/{count}/g, incompleteCount.toString());
}

// Generate a random time between 18:00-23:00 for each user
// We check if current time is within a 15-minute window of the generated time
function shouldSendNotification(userId: string, currentHour: number, currentMinute: number): boolean {
  // Only send between 18:00 and 23:00
  if (currentHour < 18 || currentHour >= 23) {
    return false;
  }

  // Use user ID to generate a pseudo-random but consistent time for this user
  // This ensures the same user gets reminded at roughly the same time each day
  const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const userHour = 18 + (hash % 5); // 18, 19, 20, 21, or 22
  const userMinute = (hash * 7) % 60; // 0-59

  // Check if we're within a 15-minute window of the user's assigned time
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const userTotalMinutes = userHour * 60 + userMinute;

  // 15-minute window
  return Math.abs(currentTotalMinutes - userTotalMinutes) <= 7;
}

interface Habit {
  id: string;
  name: string;
  icon: string;
  user_id: string;
  frequency_days: number[];
}

interface Profile {
  id: string;
  email: string;
  timezone: string;
}

interface CompletionHistory {
  habit_id: string;
  completed_at: string;
}

// Calculate current streak for a habit
function calculateCurrentStreak(
  completionDates: string[],
  frequencyDays: number[],
  today: string
): number {
  if (completionDates.length === 0) {
    return 0;
  }

  const scheduledDays = new Set(frequencyDays.map(d => Number(d)));
  const isDaily = scheduledDays.size === 0 || scheduledDays.size === 7;
  const completionSet = new Set(completionDates);

  // Parse today's date
  const [year, month, day] = today.split('-').map(Number);
  const todayDate = new Date(year, month - 1, day);

  let streak = 0;

  // Walk backwards from yesterday (today might not be completed yet)
  for (let i = 1; i < 365; i++) {
    const checkDate = new Date(todayDate);
    checkDate.setDate(checkDate.getDate() - i);

    const dateStr = checkDate.toISOString().split('T')[0];
    const dayOfWeek = checkDate.getDay();

    // Skip if this day is not scheduled
    if (!isDaily && !scheduledDays.has(dayOfWeek)) {
      continue;
    }

    if (completionSet.has(dateStr)) {
      streak++;
    } else {
      break; // Streak broken
    }
  }

  return streak;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const topicPrefix = Deno.env.get("FCM_TOPIC_PREFIX");
    const appUrl = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");
    const actionTokenSecret = Deno.env.get("ACTION_TOKEN_SECRET");

    if (!topicPrefix) {
      throw new Error("FCM_TOPIC_PREFIX is not configured");
    }

    // Without APP_URL the action URLs become relative ("/dashboard"), which the worker
    // rejects as not-http(s) with a 422 for the WHOLE request - every push would fail
    // silently, blaming the action field instead of the missing secret. Fail loudly here.
    if (!appUrl) {
      throw new Error("APP_URL is not configured");
    }

    if (!actionTokenSecret) {
      throw new Error("ACTION_TOKEN_SECRET is not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date();

    console.log(`Current UTC time: ${now.toISOString()}`);

    // Fetch all profiles with CloudPush enabled
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, email, timezone")
      .eq("notify_push", true);

    if (profilesError) {
      throw profilesError;
    }

    if (!profiles || profiles.length === 0) {
      console.log("No users with CloudPush enabled");
      return new Response(
        JSON.stringify({ message: "No users to notify", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let sentCount = 0;
    const errors: string[] = [];

    for (const profile of profiles as Profile[]) {
      const userTimezone = profile.timezone || "UTC";

      // Get current time in user's timezone
      const userLocalTime = new Date(
        now.toLocaleString("en-US", { timeZone: userTimezone })
      );
      const userHour = userLocalTime.getHours();
      const userMinute = userLocalTime.getMinutes();

      // Check if we should send notification to this user
      if (!shouldSendNotification(profile.id, userHour, userMinute)) {
        continue;
      }

      console.log(`Processing user ${profile.email} at local time ${userHour}:${userMinute}`);

      // Get today's date in user's timezone
      const today = userLocalTime.toISOString().split("T")[0];
      const todayDayOfWeek = userLocalTime.getDay();

      // Fetch user's active habits scheduled for today
      const { data: habits, error: habitsError } = await supabase
        .from("habits")
        .select("id, name, icon, user_id, frequency_days")
        .eq("user_id", profile.id)
        .eq("is_archived", false);

      if (habitsError) {
        console.error(`Error fetching habits for ${profile.email}:`, habitsError);
        continue;
      }

      if (!habits || habits.length === 0) {
        continue;
      }

      // Filter habits scheduled for today
      const todaysHabits = (habits as Habit[]).filter(h => {
        if (!h.frequency_days || h.frequency_days.length === 0) return true;
        return h.frequency_days.some(d => Number(d) === todayDayOfWeek);
      });

      if (todaysHabits.length === 0) {
        continue;
      }

      // Get today's completions
      const { data: todayCompletions } = await supabase
        .from("completions")
        .select("habit_id")
        .eq("user_id", profile.id)
        .eq("completed_at", today);

      const completedHabitIds = new Set(
        (todayCompletions || []).map((c: { habit_id: string }) => c.habit_id)
      );

      // Find incomplete habits
      const incompleteHabits = todaysHabits.filter(h => !completedHabitIds.has(h.id));

      if (incompleteHabits.length === 0) {
        console.log(`User ${profile.email} has completed all habits today`);
        continue;
      }

      // Fetch completion history (last 365 days) to calculate streaks
      const yearAgo = new Date(userLocalTime);
      yearAgo.setDate(yearAgo.getDate() - 365);
      const yearAgoStr = yearAgo.toISOString().split("T")[0];

      const { data: historyData } = await supabase
        .from("completions")
        .select("habit_id, completed_at")
        .eq("user_id", profile.id)
        .gte("completed_at", yearAgoStr);

      // Group completions by habit
      const completionsByHabit: Record<string, string[]> = {};
      (historyData as CompletionHistory[] || []).forEach(c => {
        if (!completionsByHabit[c.habit_id]) {
          completionsByHabit[c.habit_id] = [];
        }
        completionsByHabit[c.habit_id].push(c.completed_at);
      });

      // Find habits with streaks at risk
      let maxStreak = 0;
      let habitWithMaxStreak: Habit | null = null;

      for (const habit of incompleteHabits) {
        const dates = completionsByHabit[habit.id] || [];
        const streak = calculateCurrentStreak(dates, habit.frequency_days || [], today);

        if (streak > maxStreak) {
          maxStreak = streak;
          habitWithMaxStreak = habit;
        }
      }

      // Only send notification if there's a significant streak at risk (more than 5 days)
      if (maxStreak <= 5 || !habitWithMaxStreak) {
        console.log(`User ${profile.email} has no significant streaks at risk (streak: ${maxStreak})`);
        continue;
      }

      // Generate user's topic
      const topic = userTopic(topicPrefix, profile.email);

      // Determine urgency (after 21:00 is urgent)
      const isUrgent = userHour >= 21;

      // Generate message
      const body = getRandomMessage(maxStreak, incompleteHabits.length, isUrgent);
      const title = `${habitWithMaxStreak.icon} Your ${maxStreak} day streak is in danger!`;

      console.log(`Sending streak reminder to ${profile.email}: ${maxStreak} day streak at risk`);

      try {
        const allToken = await mintActionToken(actionTokenSecret, {
          userId: profile.id,
          target: "all",
          date: today,
        });
        const minimumToken = await mintActionToken(actionTokenSecret, {
          userId: profile.id,
          target: habitWithMaxStreak.id,
          date: today,
        });

        const success = await pushFcm({
          title,
          body,
          topic,
          actions: streakActions(
            appUrl,
            completeUrl(supabaseUrl, allToken),
            completeUrl(supabaseUrl, minimumToken),
          ),
        });

        if (success) {
          console.log(`Sent streak reminder to ${profile.email}`);
          sentCount++;
        } else {
          errors.push(`${profile.email}: FCM delivery failed`);
        }
      } catch (error) {
        console.error(`Failed to send streak reminder to ${profile.email}:`, error);
        errors.push(`${profile.email}: ${error}`);
      }
    }

    return new Response(
      JSON.stringify({
        message: `Processed ${profiles.length} users`,
        sent: sentCount,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in send-streak-reminders function:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
