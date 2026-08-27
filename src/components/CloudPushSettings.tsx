import { useState } from 'react';
import { Bell, Copy, Check } from 'lucide-react';
import { Button } from './ui/button';
import { useAuth } from '../features/auth/AuthContext';

const FCM_TOPIC_PREFIX = import.meta.env.VITE_FCM_TOPIC_PREFIX || 'habitify';

function getUserTopic(topicPrefix: string, email: string): string {
  const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${topicPrefix}_${username}`;
}

export function CloudPushSettings() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  if (!user?.email) {
    return null;
  }

  const userTopic = getUserTopic(FCM_TOPIC_PREFIX, user.email);

  const copyTopic = async () => {
    await navigator.clipboard.writeText(userTopic);
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
        <p className="text-xs text-muted-foreground">Your unique topic:</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-background rounded-md text-sm font-mono truncate">
            {userTopic}
          </code>
          <Button variant="outline" size="icon" onClick={copyTopic}>
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        <p className="font-medium">Setup:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Install the <strong>CloudPush</strong> app</li>
          <li>Open Subscriptions, add a topic, paste the topic above</li>
          <li>Done — habit reminders arrive there</li>
        </ol>
      </div>
    </div>
  );
}
