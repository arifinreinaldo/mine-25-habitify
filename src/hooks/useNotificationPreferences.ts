import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../features/auth/AuthContext';

export type NotificationChannel = 'notify_push' | 'notify_email';

export interface NotificationPreferences {
  notify_push: boolean;
  notify_email: boolean;
}

export interface NotificationPreferencesState {
  preferences: NotificationPreferences;
  isLoading: boolean;
  error: string | null;
}

export function useNotificationPreferences() {
  const { user } = useAuth();
  const [state, setState] = useState<NotificationPreferencesState>({
    preferences: {
      notify_push: true,
      notify_email: true,
    },
    isLoading: true,
    error: null,
  });

  // Fetch preferences on mount
  useEffect(() => {
    async function fetchPreferences() {
      if (!user) {
        setState(prev => ({ ...prev, isLoading: false }));
        return;
      }

      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('notify_push, notify_email')
          .eq('id', user.id)
          .single();

        if (error) {
          // If columns don't exist yet, use defaults
          if (error.code === 'PGRST116' || error.message.includes('column')) {
            setState(prev => ({ ...prev, isLoading: false }));
            return;
          }
          throw error;
        }

        setState({
          preferences: {
            notify_push: data?.notify_push ?? true,
            notify_email: data?.notify_email ?? true,
          },
          isLoading: false,
          error: null,
        });
      } catch (error) {
        console.error('Error fetching notification preferences:', error);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load preferences',
        }));
      }
    }

    fetchPreferences();
  }, [user]);

  // Update a single preference
  const updatePreference = useCallback(
    async (channel: NotificationChannel, enabled: boolean): Promise<boolean> => {
      if (!user) {
        setState(prev => ({ ...prev, error: 'Must be logged in to update preferences' }));
        return false;
      }

      // Optimistic update
      const previousPreferences = state.preferences;
      setState(prev => ({
        ...prev,
        preferences: { ...prev.preferences, [channel]: enabled },
        error: null,
      }));

      try {
        const { error } = await supabase
          .from('profiles')
          .update({ [channel]: enabled, updated_at: new Date().toISOString() })
          .eq('id', user.id);

        if (error) throw error;

        return true;
      } catch (error) {
        console.error(`Error updating ${channel}:`, error);
        // Rollback on error
        setState(prev => ({
          ...prev,
          preferences: previousPreferences,
          error: error instanceof Error ? error.message : 'Failed to update preference',
        }));
        return false;
      }
    },
    [user, state.preferences]
  );

  return {
    ...state,
    updatePreference,
  };
}
