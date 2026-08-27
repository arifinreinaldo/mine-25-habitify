import { Smartphone, Mail, Loader2 } from 'lucide-react';
import { useNotificationPreferences } from '../hooks/useNotificationPreferences';
import type { NotificationChannel } from '../hooks/useNotificationPreferences';
import { Switch } from './ui/switch';

interface ChannelConfig {
  key: NotificationChannel;
  icon: typeof Smartphone;
  label: string;
  description: string;
}

const channels: ChannelConfig[] = [
  {
    key: 'notify_push',
    icon: Smartphone,
    label: 'Phone (CloudPush)',
    description: 'Push notifications via the CloudPush app',
  },
  {
    key: 'notify_email',
    icon: Mail,
    label: 'Email',
    description: 'Reminder emails',
  },
];

export function NotificationPreferences() {
  const { preferences, isLoading, error, updatePreference } = useNotificationPreferences();

  if (isLoading) {
    return (
      <div className="p-4 rounded-lg bg-muted/50">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading preferences...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg bg-muted/50 space-y-4">
      <div>
        <p className="text-sm font-medium">Notification Channels</p>
        <p className="text-xs text-muted-foreground">
          Choose how you want to receive habit reminders
        </p>
      </div>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}

      <div className="space-y-3">
        {channels.map((channel) => {
          const Icon = channel.icon;
          const isEnabled = preferences[channel.key];

          return (
            <div
              key={channel.key}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{channel.label}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {channel.description}
                  </p>
                </div>
              </div>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => updatePreference(channel.key, checked)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
