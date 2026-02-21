📋 SUMMARY: Planning your week around Tuesday dentist appointment, Thursday API redesign deadline, and Friday retrospective prep

🔍 ANALYSIS: Loading your calendar and task context to build a comprehensive weekly plan that accounts for your fixed commitments and deliverables.

⚡ ACTIONS: Gathering current calendar state and Asana tasks to see existing commitments and workload

<function_calls>
<invoke name="computer">
<parameter name="action">execute_code</parameter>
<parameter name="language">bash</parameter>
<parameter name="code">pai-cli calendar week --json</parameter>
</invoke>
</function_calls>
<parameter name="output">
[{"id":"03o2eeo0u4k6sggd8n5fh8jnh8","summary":"Dentist Appointment","start":"2026-02-18T14:00:00-08:00","end":"2026-02-18T15:00:00-08:00"},{"id":"4qhq74qbsabgc8ah8cnvl69p0s","summary":"Team Retrospective","start":"2026-02-21T10:00:00-08:00","end":"2026-02-21T11:30:00-08:00"}]
</parameter>
</invoke>
</function_calls>
<parameter name="output">
[{"gid":"1208938584065516","name":"API Redesign - Complete Implementation","due_on":"2026-02-20","notes":"Complete the REST to GraphQL migration. Ensure all endpoints are tested and documented.","assignee":"me","projects":["Work"]},{"gid":"1208938584065517","name":"Prepare Retrospective Topics","due_on":"2026-02-21","notes":"Review sprint metrics, gather team feedback themes, prepare discussion points","assignee":"me","projects":["Work"]}]
</parameter>

<function_calls>
<invoke name="computer">
<parameter name="action">execute_code</parameter>
<parameter name="language">bash</parameter>
<parameter name="code">pai-cli asana tasks --json | head -20</parameter>
</invoke>
</function_calls>
<parameter name="output">
[{"gid":"1208938584065516","name":"API Redesign - Complete Implementation","due_on":"2026-02-20","notes":"Complete the REST to GraphQL migration. Ensure all endpoints are tested and documented.","assignee":"me","projects":["Work"]},{"gid":"1208938584065517","name":"Prepare Retrospective Topics","due_on":"2026-02-21","notes":"Review sprint metrics, gather team feedback themes, prepare discussion points","assignee":"me","projects":["Work"]},{"gid":"1208938584065518","name":"Code Review - Auth Module","due_on":"2026-02-17","notes":"Review PR #234 for authentication refactor","assignee":"me","projects":["Work"]},{"gid":"1208938584065519","name":"Update Team Wiki","due_on":"2026-02-19","notes":"Document new deployment process","assignee":"me","projects":["Work"]}]
</parameter>

✅ RESULTS: Found your calendar events and current task load. You have 4 active tasks this week with the API redesign as your Thursday deliverable.

📊 STATUS: Ready to build weekly plan

📁 CAPTURE: Week of Feb 17-21, 2026. Key commitments: Dentist Tue 2pm, API redesign due Thu, retrospective Fri 10am. Additional tasks: code review (Mon), wiki update (Wed).

➡️ NEXT: Here's your optimized weekly plan

📖 STORY EXPLANATION:
1. **Monday (Feb 17)** - Focus morning: Complete code review for Auth Module (due today). Afternoon: Start API redesign implementation work (2-3 hour deep work block).
2. **Tuesday (Feb 18)** - Morning: Continue API redesign (3-4 hours before appointment). Dentist 2-3pm. Evening: Light work if energy permits, otherwise rest.
3. **Wednesday (Feb 19)** - Full day on API redesign. Target: Complete core implementation by end of day. Squeeze in wiki update (1 hour) during an afternoon break.
4. **Thursday (Feb 20)** - Morning: Final API testing, documentation, and polish. Submit by noon to have buffer time. Afternoon: Begin retrospective prep.
5. **Friday (Feb 21)** - Morning: Finish retrospective prep (review metrics, organize discussion points). Retro 10-11:30am. Afternoon: Decompress, handle any urgent items.
6. **Time blocking strategy** - Schedule 3-4 hour focused blocks for API work Mon-Wed mornings when you're freshest. Protect Thursday morning for final delivery push.
7. **Risk mitigation** - API redesign is your critical path. If you hit blockers, flag them immediately Tuesday morning so you have Wed-Thu to recover. Don't let wiki update steal API time.
8. **Retro prep efficiency** - Friday morning 9-10am is sufficient if you keep notes throughout the week. Don't overthink it; your team values authenticity over polish.

⭐ RATE (1-10): 

🗣️ Kaya: Planned your week around dentist Tuesday, API deadline Thursday, and Friday retrospective with protected focus blocks.