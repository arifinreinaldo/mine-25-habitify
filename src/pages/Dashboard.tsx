import { useEffect, useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../lib/supabase';
import { useAuth } from '../features/auth/AuthContext';
import { HabitDialog } from '../components/habits/HabitDialog';
import { HabitList } from '../components/habits/HabitList';
import { HabitCalendar } from '../components/habits/HabitCalendar';
import type { Completion } from '../types/habit';
import { InstallPrompt } from '../components/InstallPrompt';
import { NotificationPreferences } from '../components/NotificationPreferences';
import { NotificationSettings } from '../components/NotificationSettings';
import { NtfySettings } from '../components/NtfySettings';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { ModeToggle } from '../components/mode-toggle';
import type { Habit, StreakData } from '../types/habit';
import { calculateStreak } from '../lib/streaks';
import { format, subDays } from 'date-fns';
import { Loader2, LogOut, Plus, Settings, Edit, Trash2, Smartphone, Calendar, List } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useNavigate } from 'react-router-dom';

// Android Widget Connection Component
function AndroidWidgetConnect() {
    const [isConnecting, setIsConnecting] = useState(false);

    const connectWidget = async () => {
        setIsConnecting(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                // URL encode the tokens to handle special characters
                const encodedAccessToken = encodeURIComponent(session.access_token);
                const encodedRefreshToken = encodeURIComponent(session.refresh_token);
                const deepLink = `habitify://auth?access_token=${encodedAccessToken}&refresh_token=${encodedRefreshToken}`;
                window.location.href = deepLink;
            }
        } catch (error) {
            console.error('Error connecting widget:', error);
        } finally {
            setIsConnecting(false);
        }
    };

    return (
        <div className="p-4 rounded-2xl bg-surface/50 border border-muted/20">
            <div className="flex items-center gap-3 mb-3">
                <Smartphone className="h-5 w-5 text-primary" />
                <h3 className="font-semibold">Android Widget</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
                Add a home screen widget to track your habits on Android. Install the Habitify Widget app first.
            </p>
            <Button
                onClick={connectWidget}
                disabled={isConnecting}
                variant="outline"
                className="w-full rounded-xl"
            >
                {isConnecting ? (
                    <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Connecting...
                    </>
                ) : (
                    'Connect Android Widget'
                )}
            </Button>
        </div>
    );
}

// Memoize today's date to avoid recalculating on every render
const today = format(new Date(), 'yyyy-MM-dd');
const todayDayOfWeek = new Date().getDay();

export default function Dashboard() {
    const { user, signOut } = useAuth();
    const navigate = useNavigate();
    const [habits, setHabits] = useState<Habit[]>([]);
    const [completedIds, setCompletedIds] = useState<Set<string>>(new Set()); // Use Set for O(1) lookup
    const [progressValues, setProgressValues] = useState<Record<string, number>>({});
    const [completionNotes, setCompletionNotes] = useState<Record<string, string>>({});
    const [streakData, setStreakData] = useState<Record<string, StreakData>>({});
    const [allCompletions, setAllCompletions] = useState<Completion[]>([]);
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [editingHabit, setEditingHabit] = useState<Habit | null>(null);
    const [showUpcoming, setShowUpcoming] = useState(false);

    // Memoize filtered habits to avoid re-filtering on every render
    const todaysHabits = useMemo(() => habits.filter(h => {
        if (!h.frequency_days || h.frequency_days.length === 0) return true;
        return h.frequency_days.some(d => Number(d) === todayDayOfWeek);
    }), [habits]);

    const upcomingHabits = useMemo(() => habits.filter(h => {
        if (!h.frequency_days || h.frequency_days.length === 0) return false;
        return !h.frequency_days.some(d => Number(d) === todayDayOfWeek);
    }), [habits]);

    // Convert Set to array for HabitList (which expects string[])
    const completedIdsArray = useMemo(() => Array.from(completedIds), [completedIds]);

    useEffect(() => {
        if (user) {
            fetchData();
            // Update page title with username
            const username = user.email?.split('@')[0] || 'User';
            document.title = `${username}'s Habits | Habitify`;
        }
    }, [user]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const yearAgo = format(subDays(new Date(), 365), 'yyyy-MM-dd');

            // Single RPC call to fetch both habits and completions
            const { data, error } = await supabase.rpc('get_dashboard_data', {
                p_year_ago: yearAgo
            });

            if (error) throw error;

            const habitsData: Habit[] = data?.habits || [];
            const completionsData: { habit_id: string; completed_at: string; value: number; notes: string; id: string; user_id: string; created_at: string }[] = data?.completions || [];

            setHabits(habitsData);
            setAllCompletions(completionsData as Completion[]);

            // Filter today's completions from the full dataset
            const todayCompletions = completionsData.filter(c => c.completed_at === today);
            setCompletedIds(new Set(todayCompletions.map(c => c.habit_id)));

            // Build progress values and notes maps from today's data
            const progressMap: Record<string, number> = {};
            const notesMap: Record<string, string> = {};
            todayCompletions.forEach(c => {
                progressMap[c.habit_id] = c.value || 1;
                if (c.notes) notesMap[c.habit_id] = c.notes;
            });
            setProgressValues(progressMap);
            setCompletionNotes(notesMap);

            // Group completion dates by habit_id for streak calculation
            const completionsByHabit: Record<string, string[]> = {};
            completionsData.forEach(c => {
                if (!completionsByHabit[c.habit_id]) {
                    completionsByHabit[c.habit_id] = [];
                }
                completionsByHabit[c.habit_id].push(c.completed_at);
            });

            // Calculate streaks for each habit
            const streaks: Record<string, StreakData> = {};
            habitsData.forEach(habit => {
                const dates = completionsByHabit[habit.id] || [];
                streaks[habit.id] = calculateStreak(dates, habit.frequency_days || [], today);
            });
            setStreakData(streaks);
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveHabit = async (habitData: Partial<Habit>) => {
        try {
            if (editingHabit) {
                // Update existing
                const { data, error } = await supabase
                    .from('habits')
                    .update(habitData)
                    .eq('id', editingHabit.id)
                    .select()
                    .single();

                if (error) throw error;
                setHabits(prev => prev.map(h => h.id === editingHabit.id ? data : h));
            } else {
                // Create new
                const { data, error } = await supabase
                    .from('habits')
                    .insert([{ ...habitData, user_id: user!.id }])
                    .select()
                    .single();

                if (error) throw error;
                setHabits([...habits, data]);
            }
            setIsDialogOpen(false);
        } catch (error) {
            console.error('Error saving habit:', error);
        }
    };

    const handleToggleHabit = useCallback(async (habitId: string) => {
        const isCompleted = completedIds.has(habitId);

        // Optimistic Update with Set
        setCompletedIds(prev => {
            const next = new Set(prev);
            if (isCompleted) {
                next.delete(habitId);
            } else {
                next.add(habitId);
            }
            return next;
        });

        try {
            if (isCompleted) {
                // Delete completion
                const { error } = await supabase
                    .from('completions')
                    .delete()
                    .eq('habit_id', habitId)
                    .eq('completed_at', today);
                if (error) throw error;
                // Clear progress value
                setProgressValues(prev => {
                    const newValues = { ...prev };
                    delete newValues[habitId];
                    return newValues;
                });
            } else {
                // Insert completion
                const { error } = await supabase
                    .from('completions')
                    .insert({
                        habit_id: habitId,
                        user_id: user!.id,
                        completed_at: today,
                        value: 1
                    });
                if (error) throw error;
                setProgressValues(prev => ({ ...prev, [habitId]: 1 }));
            }
        } catch (error) {
            console.error('Error toggling habit:', error);
            // Revert on error
            setCompletedIds(prev => {
                const next = new Set(prev);
                if (isCompleted) {
                    next.add(habitId);
                } else {
                    next.delete(habitId);
                }
                return next;
            });
        }
    }, [completedIds, user]);

    const handleUpdateProgress = useCallback(async (habitId: string, newValue: number) => {
        const habit = habits.find(h => h.id === habitId);
        if (!habit) return;

        const target = habit.frequency_target || 1;
        const clampedValue = Math.max(0, Math.min(newValue, target));
        const previousValue = progressValues[habitId] || 0;
        const wasCompleted = completedIds.has(habitId);

        // Optimistic update
        if (clampedValue === 0) {
            setCompletedIds(prev => {
                const next = new Set(prev);
                next.delete(habitId);
                return next;
            });
            setProgressValues(prev => {
                const newValues = { ...prev };
                delete newValues[habitId];
                return newValues;
            });
        } else {
            if (!wasCompleted) {
                setCompletedIds(prev => {
                    const next = new Set(prev);
                    next.add(habitId);
                    return next;
                });
            }
            setProgressValues(prev => ({ ...prev, [habitId]: clampedValue }));
        }

        try {
            if (clampedValue === 0) {
                // Delete completion
                const { error } = await supabase
                    .from('completions')
                    .delete()
                    .eq('habit_id', habitId)
                    .eq('completed_at', today);
                if (error) throw error;
            } else if (!wasCompleted) {
                // Insert new completion
                const { error } = await supabase
                    .from('completions')
                    .insert({
                        habit_id: habitId,
                        user_id: user!.id,
                        completed_at: today,
                        value: clampedValue
                    });
                if (error) throw error;
            } else {
                // Update existing completion
                const { error } = await supabase
                    .from('completions')
                    .update({ value: clampedValue })
                    .eq('habit_id', habitId)
                    .eq('completed_at', today);
                if (error) throw error;
            }
        } catch (error) {
            console.error('Error updating progress:', error);
            // Revert on error
            if (previousValue === 0) {
                setCompletedIds(prev => {
                    const next = new Set(prev);
                    next.delete(habitId);
                    return next;
                });
                setProgressValues(prev => {
                    const newValues = { ...prev };
                    delete newValues[habitId];
                    return newValues;
                });
            } else {
                if (!wasCompleted) {
                    setCompletedIds(prev => {
                        const next = new Set(prev);
                        next.delete(habitId);
                        return next;
                    });
                }
                setProgressValues(prev => ({ ...prev, [habitId]: previousValue }));
            }
        }
    }, [habits, progressValues, completedIds, user]);

    const handleUpdateNotes = useCallback(async (habitId: string, notes: string) => {
        const previousNotes = completionNotes[habitId] || '';

        // Optimistic update
        if (notes) {
            setCompletionNotes(prev => ({ ...prev, [habitId]: notes }));
        } else {
            setCompletionNotes(prev => {
                const newNotes = { ...prev };
                delete newNotes[habitId];
                return newNotes;
            });
        }

        try {
            const { error } = await supabase
                .from('completions')
                .update({ notes: notes || null })
                .eq('habit_id', habitId)
                .eq('completed_at', today);

            if (error) throw error;
        } catch (error) {
            console.error('Error updating notes:', error);
            // Revert on error
            if (previousNotes) {
                setCompletionNotes(prev => ({ ...prev, [habitId]: previousNotes }));
            } else {
                setCompletionNotes(prev => {
                    const newNotes = { ...prev };
                    delete newNotes[habitId];
                    return newNotes;
                });
            }
        }
    }, [completionNotes]);

    const handleDeleteHabit = useCallback(async (habitId: string) => {
        if (!confirm('Are you sure you want to delete this habit?')) return;

        // Optimistic Update
        setHabits(prev => prev.filter(h => h.id !== habitId));

        try {
            const { error } = await supabase
                .from('habits')
                .delete()
                .eq('id', habitId);

            if (error) throw error;
        } catch (error) {
            console.error('Error deleting habit:', error);
            fetchData(); // Sync on error
        }
    }, []);

    const handleEditHabit = useCallback((habit: Habit) => {
        setEditingHabit(habit);
        setIsDialogOpen(true);
    }, []);

    const handleSignOut = async () => {
        await signOut();
        navigate('/login');
    };



    if (loading) {
        return <div className="min-h-screen bg-background flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>;
    }

    return (
        <div className="min-h-screen bg-background text-text pb-32 bg-noise">
            {/* Header */}
            <header className="sticky top-0 z-10 border-b border-white/5 bg-background/80 backdrop-blur-xl">
                <div className="container mx-auto px-4 py-4 flex items-center justify-between">
                    <motion.div
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex flex-col"
                    >
                        <h1 className="text-2xl font-bold font-display bg-gradient-to-r from-primary via-secondary to-accent bg-clip-text text-transparent animate-gradient-x">
                            Hello, {user?.email?.split('@')[0]}!
                        </h1>
                        <p className="text-sm text-muted">{format(new Date(), 'EEEE, MMMM do')}</p>
                    </motion.div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setViewMode(viewMode === 'list' ? 'calendar' : 'list')}
                            className="rounded-full"
                            title={viewMode === 'list' ? 'Calendar view' : 'List view'}
                        >
                            {viewMode === 'list' ? <Calendar className="h-5 w-5" /> : <List className="h-5 w-5" />}
                        </Button>
                        <ModeToggle />
                        <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(true)} className="rounded-full">
                            <Settings className="h-5 w-5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={handleSignOut} className="rounded-full">
                            <LogOut className="h-5 w-5" />
                        </Button>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="container mx-auto px-4 py-8 space-y-8">
                {/* Stats Overview - only show in list view */}
                {viewMode === 'list' && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 }}
                        className="grid grid-cols-2 gap-4"
                    >
                        <div className="p-4 rounded-3xl bg-surface/40 backdrop-blur-md border border-white/10 shadow-sm relative overflow-hidden group hover:shadow-primary/20 transition-all duration-500">
                            <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors" />
                            <div className="relative z-10">
                                <div className="text-3xl font-bold font-display text-primary">{todaysHabits.filter(h => completedIds.has(h.id)).length}/{todaysHabits.length}</div>
                                <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mt-1">Completed Today</div>
                            </div>
                        </div>
                        <div className="p-4 rounded-3xl bg-surface/40 backdrop-blur-md border border-white/10 shadow-sm relative overflow-hidden group hover:shadow-success/20 transition-all duration-500">
                            <div className="absolute inset-0 bg-success/5 group-hover:bg-success/10 transition-colors" />
                            <div className="relative z-10">
                                <div className="text-3xl font-bold font-display text-success w-fit">
                                    {Math.round((todaysHabits.filter(h => completedIds.has(h.id)).length / (todaysHabits.length || 1)) * 100)}%
                                </div>
                                <div className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mt-1">Completion Rate</div>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* View Toggle Content */}
                {viewMode === 'calendar' ? (
                    <HabitCalendar habits={habits} completions={allCompletions} />
                ) : (
                    /* Habit Sections */
                    <div className="space-y-8">
                        <HabitList
                            title="🌅 Early Morning"
                            habits={todaysHabits.filter(h => h.time_of_day === 'early_morning')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        <HabitList
                            title="☀️ Morning"
                            habits={todaysHabits.filter(h => h.time_of_day === 'morning')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        <HabitList
                            title="🌤️ Afternoon"
                            habits={todaysHabits.filter(h => h.time_of_day === 'afternoon')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        <HabitList
                            title="🌆 Evening"
                            habits={todaysHabits.filter(h => h.time_of_day === 'evening')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        <HabitList
                            title="⏰ Custom"
                            habits={todaysHabits.filter(h => h.time_of_day === 'custom')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        <HabitList
                            title="🚫 No Reminder"
                            habits={todaysHabits.filter(h => h.time_of_day === 'anytime')}
                            completedHabitIds={completedIdsArray}
                            progressValues={progressValues}
                            completionNotes={completionNotes}
                            onToggle={handleToggleHabit}
                            onUpdateProgress={handleUpdateProgress}
                            onUpdateNotes={handleUpdateNotes}
                            onDelete={handleDeleteHabit}
                            onEdit={handleEditHabit}
                            streakData={streakData}
                        />

                        {todaysHabits.length === 0 && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="text-center py-20 text-muted flex flex-col items-center gap-4"
                            >
                                <div className="text-6xl animate-bounce-slow">🌱</div>
                                <p className="text-lg font-medium">{habits.length === 0 ? 'No habits yet. Start small!' : 'No habits scheduled for today!'}</p>
                            </motion.div>
                        )}

                        {/* Upcoming Habits (collapsible) */}
                        {upcomingHabits.length > 0 && (
                            <div className="pt-8 border-t border-white/5">
                                <button
                                    onClick={() => setShowUpcoming(!showUpcoming)}
                                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-text transition-colors mb-4 group"
                                >
                                    <span className={`transition-transform duration-300 ${showUpcoming ? 'rotate-90' : ''} group-hover:text-primary`}>▶</span>
                                    <span className="font-medium">Upcoming ({upcomingHabits.length})</span>
                                </button>
                                <AnimatePresence>
                                    {showUpcoming && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 0.6 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.3 }}
                                            className="overflow-hidden"
                                        >
                                            {upcomingHabits.map(habit => (
                                                <div key={habit.id} className="py-2 px-3 rounded-2xl bg-surface/30 mb-2 flex items-center gap-3 border border-white/5">
                                                    <span className="text-xl opacity-80">{habit.icon}</span>
                                                    <div className="flex-1">
                                                        <div className="font-medium text-sm">{habit.name}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {habit.frequency_days?.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(d)]).join(', ')}
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-1">
                                                        <button
                                                            onClick={() => handleEditHabit(habit)}
                                                            className="p-1.5 text-muted-foreground hover:text-primary transition-colors"
                                                        >
                                                            <Edit className="h-4 w-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteHabit(habit.id)}
                                                            className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {/* Floating Action Button */}
            <div className="fixed bottom-8 right-6 z-50">
                <motion.div
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                >
                    <Button
                        className="gap-2 shadow-xl shadow-primary/25 rounded-full h-14 px-6 text-base font-semibold bg-primary hover:bg-primary/90 transition-all"
                        onClick={() => {
                            setEditingHabit(null);
                            setIsDialogOpen(true);
                        }}
                    >
                        <Plus className="h-5 w-5" /> New Habit
                    </Button>
                </motion.div>
            </div>

            <HabitDialog
                open={isDialogOpen}
                onOpenChange={setIsDialogOpen}
                onSave={handleSaveHabit}
                habitToEdit={editingHabit || undefined}
            />

            {/* Settings Dialog */}
            <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                <DialogContent className="sm:max-w-[425px] max-h-[85vh] flex flex-col rounded-3xl bg-surface/90 backdrop-blur-xl border-white/10">
                    <DialogHeader>
                        <DialogTitle className="font-display text-xl">Settings</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4 overflow-y-auto flex-1">
                        <InstallPrompt />
                        <NotificationSettings />
                        <NotificationPreferences />
                        <NtfySettings />
                        <AndroidWidgetConnect />
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
