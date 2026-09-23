import React from "react";
import {
  EVENT_SCHEDULE_TIMEZONE_OPTIONS,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  type EventScheduleTimezone,
} from "@mons/shared/events";
import {
  ExperimentalActionButton,
  ExperimentalInlineError,
  ExperimentalInput,
  ExperimentalSelect,
  ScheduleModeButton,
  ScheduleModeToggle,
  TelegramAnnouncements,
  TelegramAnnouncementsHint,
  TelegramAnnouncementToggle,
  ToggleRow,
} from "./EventCreateForm.styles";
import type { useEventCreateForm } from "./useEventCreateForm";

const TELEGRAM_ANNOUNCEMENT_OPTIONS = [
  { key: "invite", label: "Invite when created" },
  { key: "matches", label: "Event start and match updates" },
  { key: "results", label: "Final results" },
] as const;

type EventCreateFormProps = {
  form: ReturnType<typeof useEventCreateForm>;
  canCreateEvents: boolean;
};

export const EventCreateForm = ({
  form,
  canCreateEvents,
}: EventCreateFormProps) => (
  <>
    {canCreateEvents && (
      <>
        <ScheduleModeToggle>
          <ScheduleModeButton
            type="button"
            $active={form.schedule.mode === "minutes"}
            onClick={() => form.setScheduleField("mode", "minutes")}
          >
            In minutes
          </ScheduleModeButton>
          <ScheduleModeButton
            type="button"
            $active={form.schedule.mode === "datetime"}
            onClick={() => form.setScheduleField("mode", "datetime")}
          >
            Date & time
          </ScheduleModeButton>
        </ScheduleModeToggle>
        {form.schedule.mode === "minutes" ? (
          <ExperimentalInput
            type="number"
            min={MIN_STARTS_IN_MINUTES}
            max={MAX_STARTS_IN_MINUTES}
            step="1"
            value={form.schedule.startsInMinutes}
            onChange={(event) =>
              form.setScheduleField("startsInMinutes", event.target.value)
            }
            placeholder="minutes from now"
          />
        ) : (
          <>
            <ExperimentalInput
              type="date"
              value={form.schedule.scheduledDate}
              onChange={(event) =>
                form.setScheduleField("scheduledDate", event.target.value)
              }
            />
            <ExperimentalInput
              type="time"
              step="60"
              value={form.schedule.scheduledTime}
              onChange={(event) =>
                form.setScheduleField("scheduledTime", event.target.value)
              }
            />
            <ExperimentalSelect
              value={form.schedule.scheduledTimezone}
              onChange={(event) =>
                form.setScheduleField(
                  "scheduledTimezone",
                  event.target.value as EventScheduleTimezone,
                )
              }
            >
              {EVENT_SCHEDULE_TIMEZONE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ExperimentalSelect>
          </>
        )}
        <ToggleRow>
          <input
            type="checkbox"
            checked={form.isSundayMons}
            onChange={(event) => form.setIsSundayMons(event.target.checked)}
          />
          Sunday Mons
        </ToggleRow>
        <TelegramAnnouncements aria-describedby="event-telegram-announcements-hint">
          <legend>Telegram announcements</legend>
          {TELEGRAM_ANNOUNCEMENT_OPTIONS.map(({ key, label }) => (
            <TelegramAnnouncementToggle key={key}>
              <input
                type="checkbox"
                checked={form.telegramAnnouncements[key]}
                onChange={(event) =>
                  form.setTelegramAnnouncement(key, event.target.checked)
                }
              />
              {label}
            </TelegramAnnouncementToggle>
          ))}
          <TelegramAnnouncementsHint id="event-telegram-announcements-hint">
            Once an invite is sent, it updates as people join.
          </TelegramAnnouncementsHint>
        </TelegramAnnouncements>
        <ExperimentalActionButton
          type="button"
          onClick={form.submit}
          disabled={form.isCreatingEvent}
        >
          {form.isCreatingEvent ? "Creating Event..." : "Create Event"}
        </ExperimentalActionButton>
      </>
    )}
    {form.error !== "" && (
      <ExperimentalInlineError>{form.error}</ExperimentalInlineError>
    )}
  </>
);
