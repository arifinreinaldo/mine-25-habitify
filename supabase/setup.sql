-- Habitify Database Setup
-- Run this entire script in Supabase SQL Editor (supabase.com → SQL Editor → New Query)

-- 1. TABLES
CREATE TABLE habits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '📝',
  color TEXT DEFAULT '#6366f1',
  time_of_day TEXT DEFAULT 'anytime' CHECK (time_of_day IN ('early_morning', 'morning', 'afternoon', 'evening', 'custom', 'anytime')),
  frequency_type TEXT DEFAULT 'daily' CHECK (frequency_type IN ('daily', 'weekly', 'custom')),
  frequency_days INTEGER[] DEFAULT '{0,1,2,3,4,5,6}',
  frequency_target INTEGER,
  reminder_time TIME,
  is_archived BOOLEAN DEFAULT FALSE,
  position INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE completions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  habit_id UUID REFERENCES habits(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  completed_at DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(habit_id, completed_at)
);

-- 2. INDEXES (faster queries)
CREATE INDEX idx_habits_user_id ON habits(user_id);
CREATE INDEX idx_completions_user_date ON completions(user_id, completed_at);
CREATE INDEX idx_completions_habit_id ON completions(habit_id);

-- 3. ROW LEVEL SECURITY
ALTER TABLE habits ENABLE ROW LEVEL SECURITY;
ALTER TABLE completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own habits" ON habits FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users manage own completions" ON completions FOR ALL USING (auth.uid() = user_id);

-- 4. PROFILES TABLE (for user timezone)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  notify_push BOOLEAN DEFAULT true,
  notify_email BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own profile" ON profiles FOR ALL USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. INDEX for reminder queries
CREATE INDEX idx_habits_reminder_time ON habits(reminder_time) WHERE reminder_time IS NOT NULL;

-- 6. NOTIFICATION PREFERENCES (add columns to profiles)
-- Run this migration for existing databases:
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notify_push BOOLEAN DEFAULT true;
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT true;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS notify_ntfy;
-- DROP TABLE IF EXISTS push_subscriptions;

-- For new installations, these columns are included in the profiles table definition above.
-- If you're setting up fresh, modify the profiles table creation to include:
--   notify_push BOOLEAN DEFAULT true,
--   notify_email BOOLEAN DEFAULT true,

-- 7. CRON SETUP (run after enabling pg_cron and pg_net extensions in Supabase dashboard)
-- Enable extensions first:
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule reminder function every 15 minutes
-- Replace YOUR_SUPABASE_URL with your actual Supabase URL
-- Replace YOUR_ANON_KEY with your actual anon key
/*
SELECT cron.schedule(
  'send-habit-reminders',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'YOUR_SUPABASE_URL/functions/v1/send-reminders',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Schedule habit reminder function every 15 minutes (matches a 5-minute window per user timezone)
-- This sends CloudPush (FCM) reminders for individual habits via the cloudflare-notifier worker
SELECT cron.schedule(
  'send-ntfy-notifications',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'YOUR_SUPABASE_URL/functions/v1/send-ntfy-notifications',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Schedule streak reminder function every 15 minutes (sends between 18:00-23:00 user local time)
-- This sends Duolingo-style passive-aggressive reminders when streaks are at risk via CloudPush (FCM)
SELECT cron.schedule(
  'send-streak-reminders',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'YOUR_SUPABASE_URL/functions/v1/send-streak-reminders',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
*/

-- 8. RPC FUNCTION: Fetch dashboard data in single call (habits + completions)
-- This reduces API calls from 2 to 1 on dashboard load
CREATE OR REPLACE FUNCTION get_dashboard_data(p_year_ago DATE)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'habits', (
      SELECT COALESCE(json_agg(h ORDER BY h.created_at), '[]'::json)
      FROM habits h
      WHERE h.user_id = auth.uid()
        AND h.is_archived = false
    ),
    'completions', (
      SELECT COALESCE(json_agg(c), '[]'::json)
      FROM completions c
      WHERE c.user_id = auth.uid()
        AND c.completed_at >= p_year_ago
    )
  ) INTO result;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. RPC FUNCTION: Get widget data (streak, progress) for Android widget
CREATE OR REPLACE FUNCTION get_widget_data()
RETURNS JSON AS $$
DECLARE
  result JSON;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT json_build_object(
    'total_habits', (
      SELECT COUNT(*)::int FROM habits h
      WHERE h.user_id = auth.uid() AND h.is_archived = false
    ),
    'completed_today', (
      SELECT COUNT(DISTINCT habit_id)::int FROM completions c
      WHERE c.user_id = auth.uid() AND c.completed_at = v_today
    ),
    'current_streak', (
      -- Max consecutive days with at least one habit completed
      SELECT COALESCE(MAX(streak), 0)::int FROM (
        SELECT COUNT(*) as streak FROM (
          SELECT completed_at, completed_at - (ROW_NUMBER() OVER (ORDER BY completed_at))::int AS grp
          FROM (SELECT DISTINCT completed_at FROM completions WHERE user_id = auth.uid()) d
        ) grouped GROUP BY grp
      ) streaks
    )
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
