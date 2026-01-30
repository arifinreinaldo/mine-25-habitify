import { useState } from 'react';
import { Bell, Smartphone, Mail, Loader2, AlertCircle } from 'lucide-react';
import { useNotificationPreferences } from '../hooks/useNotificationPreferences';
import type { NotificationChannel } from '../hooks/useNotificationPreferences';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { Switch } from './ui/switch';

interface ChannelConfig {
  key: NotificationChannel;
  icon: typeof Bell;
  label: string;
  description: string;
}

const channels: ChannelConfig[] = [
  {
    key: 'notify_push',
    icon: Bell,
    label: 'Web Push',
    description: 'Push notifications on this device',
  },
  {
    key: 'notify_ntfy',
    icon: Smartphone,
    label: 'Phone (ntfy)',
    description: 'via ntfy.sh app',
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
  const push = usePushNotifications();
  const [pushBusy, setPushBusy] = useState(false);

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

  const handlePushToggle = async (enabled: boolean) => {
    setPushBusy(true);
    try {
      if (enabled) {
        // Subscribe to browser push first, then save preference
        const ok = await push.subscribe();
        if (ok) {
          await updatePreference('notify_push', true);
        }
        // If subscribe failed, don't flip the preference
      } else {
        // Unsubscribe from browser push, then save preference
        await push.unsubscribe();
        await updatePreference('notify_push', false);
      }
    } finally {
      setPushBusy(false);
    }
  };

  const pushNotSupported = !push.isSupported;
  const pushNotConfigured = push.isSupported && !push.isConfigured;
  const pushDenied = push.permission === 'denied';
  const pushDisabled = pushNotSupported || pushNotConfigured || pushDenied;

  const getPushDescription = () => {
    if (pushNotSupported) return 'Not supported in this browser';
    if (pushNotConfigured) return 'Push not configured on server';
    if (pushDenied) return 'Permission denied — enable in browser settings';
    if (push.isSubscribed) return 'Subscribed on this device';
    return 'Push notifications on this device';
  };

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
      {push.error && (
        <div className="flex items-center gap-2 text-xs text-red-500">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          <span>{push.error}</span>
        </div>
      )}

      <div className="space-y-3">
        {channels.map((channel) => {
          const Icon = channel.icon;
          const isPush = channel.key === 'notify_push';
          const isEnabled = isPush
            ? push.isSubscribed && preferences[channel.key]
            : preferences[channel.key];
          const isDisabled = isPush ? pushDisabled || pushBusy : false;
          const description = isPush ? getPushDescription() : channel.description;

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
                    {description}
                  </p>
                </div>
              </div>
              {isPush && pushBusy ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              ) : (
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(checked) =>
                    isPush
                      ? handlePushToggle(checked)
                      : updatePreference(channel.key, checked)
                  }
                  disabled={isDisabled}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
