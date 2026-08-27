import { useState, useEffect } from 'react';
import { Bell, Copy, Check, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { useAuth } from '../features/auth/AuthContext';
import { supabase } from '../lib/supabase';

export function CloudPushSettings() {
  const { user } = useAuth();
  const [topic, setTopic] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // The topic is read from profiles.push_topic, never derived from the email. The push
  // payload carries a habit-completion token, so a guessable topic would hand anyone who
  // subscribed to it a working credential.
  useEffect(() => {
    // No synchronous setState here: without a user the component renders null anyway,
    // so the loading branch is unreachable and setting it would only trip
    // react-hooks/set-state-in-effect.
    if (!user) return;

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('push_topic')
        .eq('id', user.id)
        .single();

      if (cancelled) return;
      if (error) console.error('Error loading push topic:', error);
      setTopic(data?.push_topic ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  const copyTopic = async () => {
    if (!topic) return;
    await navigator.clipboard.writeText(topic);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-4 rounded-lg bg-muted/50 space-y-3">
      <div className="flex items-center gap-3">
        <Bell className="w-5 h-5 text-muted-foreground" />
        <div className="flex-1">
          <p className="text-sm font-medium">Phone Notifications (CloudPush)</p>
          <p className="text-xs text-muted-foreground">
            Get push notifications via the CloudPush app
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Your private topic:</p>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Loading…</span>
          </div>
        ) : topic ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-background rounded-md text-sm font-mono truncate">
              {topic}
            </code>
            <Button variant="outline" size="icon" onClick={copyTopic}>
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-red-500">
            No topic on your profile yet. Run the push_topic migration in supabase/setup.sql.
          </p>
        )}
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        <p className="font-medium">Setup:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Install the <strong>CloudPush</strong> app</li>
          <li>Open Subscriptions, add a topic, paste the topic above</li>
          <li>Done — habit reminders arrive there</li>
        </ol>
        <p className="pt-1">
          Treat it like a password. Anyone who subscribes to it receives your reminders and
          can mark your habits complete.
        </p>
      </div>
    </div>
  );
}
