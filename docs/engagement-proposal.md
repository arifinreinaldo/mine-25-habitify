# Habitify — Engagement Proposal

> Analysis date: 2026-08-27. Scope: what makes this app more engaging to open every day.
> Ranked by impact-per-effort. Every item cites the code that makes it cheap.
> Notification and push code is excluded — it is being rewritten.

## The one-line judgement

**Build #1 first.** The app fetches 365 days of history, computes a streak for every habit, and then
freezes that number until the next page load. The most-repeated action in the product — ticking a
checkbox — produces no visible reward. That is a one-hour fix to the core loop, and everything else
on this list is decoration until it lands.

---

## The pattern I found

This codebase has a consistent shape: **the data layer is ahead of the view layer.**

- `get_dashboard_data` pulls a full year of completions on every load (`supabase/setup.sql:157`,
  called at `src/pages/Dashboard.tsx:121`). The calendar is the only consumer.
- `calculateStreak` returns `bestStreak` (`src/lib/streaks.ts:80`). Nothing renders it.
- `is_archived` exists in the schema, the type, and the RPC filter. No UI reaches it.
- `frequency_type` is read in exactly one place, to print the word "day" or "week"
  (`src/components/habits/HabitCard.tsx:141`). It drives no logic.
- `position` is in the schema and the type. Habits sort by `created_at`.

Almost every proposal below is a view for data that is already in memory. That is why the effort
numbers are small.

---

## 1. Recompute the streak when you tick the box

**What.** After a completion toggles, update `allCompletions` in place and re-derive that habit's
streak. Today the flame count is frozen at whatever it was on page load.

**Where.** `src/pages/Dashboard.tsx:200-255` (`handleToggleHabit`) and `:257-343`
(`handleUpdateProgress`). Neither touches `setStreakData` or `setAllCompletions` — those run only
inside `fetchData` at `:162` and `:131`. `calculateStreak` is already imported at `:16`.

**Why it fits.** The flame renders only when `currentStreak > 0` (`HabitCard.tsx:98-103`). So on day
one of a new habit you tick it and *nothing appears*. On day eight you tick it and it still says 7.
The two stat tiles at `Dashboard.tsx:466` and `:474` do update live, because they derive from
`completedIds`. The streak is the single frozen number on the screen, and it is the one the whole
passive-aggressive notification voice is built around. The calendar view is stale the same way —
`allCompletions` never updates, so switching to the calendar after ticking shows an empty cell for
today.

**Effort.** Under an hour. Add the completion to `allCompletions`, re-run `calculateStreak` for that
one habit id, set both. The revert paths at `:245` and `:321` need the same treatment.

**Impact.** High, and I am confident. This is the reward moment of the product and it currently does
not fire.

---

## 2. `today` is frozen at module load

**What.** `today` and `todayDayOfWeek` are computed once, when the module is first imported. Derive
them from state instead, and refresh on `visibilitychange` plus a midnight timer.

**Where.** `src/pages/Dashboard.tsx:73-74`.

```ts
const today = format(new Date(), 'yyyy-MM-dd');
const todayDayOfWeek = new Date().getDay();
```

**Why it fits.** This is an installed PWA (`vite.config.ts:9-41`, `display: 'standalone'`). Leave it
resident past midnight and three things break at once: `todaysHabits` (`:93-96`) still filters for
yesterday's weekday, every write sends `completed_at: today` (`:236`, `:306`, `:221`) which silently
logs to *yesterday*, and the `UNIQUE(habit_id, completed_at)` constraint (`setup.sql:29`) then
rejects the insert as a duplicate if yesterday was already done. Meanwhile the header at `:430`
calls `format(new Date(), ...)` on every render, so the visible date and the write target disagree.
A completion written to the wrong date is exactly the failure that kills a streak the user earned.

**Effort.** About an hour, including a re-fetch on wake.

**Impact.** High if the app stays resident, low if the OS kills it nightly. I cannot verify the
runtime behaviour from here. But it is a correctness bug that punishes the heaviest user, and the
heaviest user is the only user.

---

## 3. Let the calendar fix yesterday

**What.** Make the per-habit rows in the calendar's day dialog tappable, so a missed day can be
logged retroactively.

**Where.** `src/components/habits/HabitCalendar.tsx:303-332` renders each habit for the selected day
with a `Check` or `X` and no interaction. Thread an `onToggleDate(habitId, dateStr)` prop down from
`Dashboard.tsx:484`.

**Why it fits.** `completed_at` is a plain `DATE` (`setup.sql:26`) and the unique constraint is
`(habit_id, completed_at)` — the write path already accepts any date, it is just always handed
`today`. `selectedDayHabits` (`HabitCalendar.tsx:112-129`) already resolves which habits were
scheduled and which were completed. Right now the only way to correct a forgotten tick is the
Supabase table editor. "I did it, I just forgot to log it" is the most common way a personal tracker
dies: the streak breaks for a bookkeeping reason, the number resets, and the app loses its grip.

**Effort.** Two to three hours. Most of it is lifting the write logic out of `handleToggleHabit` so
it takes a date parameter, which item #1 wants anyway.

**Impact.** High. Guard it — allow past dates only, never future. The calendar already disables
future cells at `:229`.

---

## 4. Delete this: `NotificationSettings.tsx`

**What.** Remove the redundant push panel. Drop the unused `select.tsx` primitive and two dead
dependencies while you are there.

**Where.** `src/pages/Dashboard.tsx:669-670` renders `NotificationSettings` and
`NotificationPreferences` back to back inside the settings dialog.

**Why it fits.** They are the same control twice. `NotificationPreferences` has a Web Push row that
calls `push.subscribe()` and `push.unsubscribe()` (`NotificationPreferences.tsx:52-70`) and renders
the identical not-supported / not-configured / denied states (`:77-83`). `NotificationSettings.tsx`
is 119 lines that do only that. Two switches for one subscription can visibly disagree. The settings
dialog is five stacked panels and three of them are about notifications — that is the friction, not
a missing feature.

Also dead: `src/components/ui/select.tsx` has no importer outside `components/ui/`, and neither
`cmdk` nor `rejections` (`package.json:23`, `:31`) is imported anywhere in `src/`. `rejections` in
particular looks like an accidental install.

**Effort.** Ten minutes.

**Impact.** Medium. Removing a confusing duplicate control is real engagement work — every extra
panel is a reason to close the dialog without changing anything.

---

## 5. Show `bestStreak`, then build the habit detail sheet

**What.** Two sizes. Small: render best streak next to the flame. Large: tap a card to open a sheet
with best streak, total completions, 30- and 90-day rate, and a mini heatmap for that one habit.

**Where.** Small: `src/components/habits/HabitCard.tsx:98-103`, using the `streak.bestStreak` that is
already passed in via the `streak` prop. Large: new component fed from `allCompletions`
(`Dashboard.tsx:84`).

**Why it fits.** `calculateStreak` computes `bestStreak` on every load for every habit
(`streaks.ts:69`, `:78`, stored at `Dashboard.tsx:157-162`) and grep finds no consumer outside
`streaks.ts` itself. A full year of completions is already in React state and only the calendar
reads it. This is Phase 4 "Reports & Analytics" from `ROADMAP.md:105-116` — the last unbuilt phase —
and the per-habit half of it needs zero new queries, zero schema change, and no charting library.

**Effort.** Fifteen minutes for the best-streak badge. Three to four hours for the sheet.

**Impact.** Medium-high for the sheet, and it compounds with #1: a visible personal record gives the
current streak something to chase. Do the fifteen-minute version this week regardless.

---

## 6. Make weekly targets mean something

**What.** For habits with `frequency_type === 'weekly'`, count this week's completions from
`allCompletions` and show "2/3 this week" with a progress bar.

**Where.** `src/components/habits/HabitCard.tsx:140-142` currently prints the target as a label:

```tsx
{!isMeasurable && target > 1 && (
    <> • {target}x/{habit.frequency_type === 'daily' ? 'day' : 'week'}</>
)}
```

**Why it fits.** That label is the app's only use of `frequency_type` anywhere outside the type
definition — I grepped. `HabitDialog.tsx:231-266` lets you carefully set "3 times per Week", and
nothing in the app ever counts to three. The card promises a goal it does not track. The weekly
count is a filter over data already in state, and the progress-bar markup already exists at
`HabitCard.tsx:246-253` for measurable habits.

Note the related gap: a boolean habit with `target > 1` per *day* shows "3x/day" but its control is a
single checkbox (`:168-172`), so it cannot be logged three times. Routing those through the counter
UI at `:145-166` is the fuller fix and needs `value` semantics on boolean completions. I would not
start there.

**Effort.** About an hour for the weekly display. Half a day for the full daily-target rework.

**Impact.** Medium. It closes a promise the UI already makes in writing.

---

## 7. Do something when the day is cleared

**What.** Fire a one-shot celebration on the transition to 100%, with a line in the product's
established voice.

**Where.** `src/pages/Dashboard.tsx:463-479` — the two stat tiles compute `completed/total` and a
percentage, hit 100%, and sit there.

**Why it fits.** Everything needed is installed. `framer-motion` is imported at `:2` and already
drives layout animation throughout. `tailwind.config.js:38-44` defines `bounce-slow`, `pulse-glow`,
`float`, and `gradient-x` keyframes, several unused. The product has a strong, specific voice already
written down — `supabase/functions/send-streak-reminders/index.ts:10-75` is a hundred lines of
"Your streak's obituary is being drafted as we speak." That voice currently only exists in
notifications the user sees when they *fail*. It has never once congratulated anyone. A dry,
suspicious compliment at 100% would be on-brand and is the cheapest personality win available.

**Effort.** One to two hours.

**Impact.** Medium, and this is the item I am least sure about. Confetti gets old fast for an
audience of one. Fire it strictly on the false→true transition, keep it under a second, and make the
copy rotate. If it annoys you after a week, it is one component to delete.

---

## 8. Archive instead of delete

**What.** Replace the destructive delete button with archive. Keep real deletion behind an archived-
habits list.

**Where.** `src/pages/Dashboard.tsx:382-399` (`handleDeleteHabit`) and the trash buttons at
`HabitCard.tsx:239-241` and `Dashboard.tsx:618-623`.

**Why it fits.** `is_archived` already exists three times over: the column (`setup.sql:17`), the type
(`src/types/habit.ts:19`), and the RPC filter that hides archived habits from the dashboard
(`setup.sql:166`). The feature is 90% built and has no button. Meanwhile the current path is a
`window.confirm()` at `:383` followed by a hard delete, and `completions` cascades on habit delete
(`setup.sql:24`) — so retiring a habit destroys its entire history, including the best streak you
were proud of. An archive is `update({ is_archived: true })`.

**Effort.** About an hour, most of it the archived-habits list in settings.

**Impact.** Medium. Mostly loss prevention, but it changes behaviour: when retiring a habit is
reversible, you experiment with new ones more freely.

---

## Three things you should know

**1. `supabase/setup.sql` cannot produce a working database.** The app reads and writes
`habits.habit_type`, `habits.unit`, and `completions.value` (`src/types/habit.ts:12-13`, `:29`;
written at `Dashboard.tsx:236`, `:306`). None of those three columns exist in `setup.sql:5-30`. They
survive only as commented-out `ALTER TABLE` lines in `ROADMAP.md:146-153`. A fresh setup run yields a
schema the app immediately fails against. That is a re-provisioning landmine and a wrong reference
for any future agent reading the schema.

**2. `get_widget_data` reports the wrong streak.** `setup.sql:197-205` computes
`MAX(streak)` over every gap-and-island group in the completion history. That is the *best* streak
ever recorded, not the current one, and nothing anchors the run to today. The widget will happily
show "47 day streak" months after you last opened the app. It also disagrees with
`calculateStreak`, which is per-habit while this is per-user — two different definitions of "streak"
shipping side by side.

**3. Streaks count intent, not achievement.** `calculateStreak` receives only dates
(`Dashboard.tsx:158-161`) and treats any completion row as a full day. Log 1 of 8 glasses of water
and the streak survives intact. That may well be deliberate and kind. It is worth deciding on
purpose, because item #6 makes the inconsistency visible: the card will show "1/8" next to an
unbroken flame.

There are also no tests anywhere in the repo — `calculateStreak` is the one piece of real logic here,
it has non-obvious control flow at `streaks.ts:58-67`, and every number the user sees depends on it.
