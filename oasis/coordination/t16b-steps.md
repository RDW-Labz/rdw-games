Fixed step contract for daily-summary 1.1.0 (all jobs use these exact names):
1. get_calendar → do: connectors.calendar.today → value {meeting_count:int, events:[{time:"HH:MM"|"all day", title:str}]}
2. get_unread → do: connectors.email.unread → value {unread_count:int, messages:[{subject:str, sender:str, received:"ISO"}] (≤10)}
3. summarize → do: model.daily_summary → value {summary:str (≤3 lines, written by the agent's default model from steps 1-2 as quoted data)}
4. write_summary → do: notes.write → value {note_id:str, meeting_count:int, unread_count:int} (counts copied from steps 1-2 data, never parsed from model text)
checker: daily_summary_matches — checks structured fields (note exists for today; counts equal steps 1-2 data; summary non-empty, ≤3 lines). It never grades model wording (PLAN:499).
