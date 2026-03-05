---
id: todo-loop
enforced_by: templates, agent CLAUDE.md
applies_to: all agents (manager, builder, tester, reviewer, researcher, devops)
---

# Rule: Todo Loop Pattern

> Every agent maintains a self-verifying, self-looping task list. Work is not done until verified. Docs are updated alongside code. The loop only terminates when all tasks pass verification.

## The Pattern

```
1. Receive work (from parent, user, or standing directive)
2. Create todo list as a FILE in workspace (todo-loop.md)
3. Work through tasks sequentially
4. After each task → read todo file → continue to next incomplete task
5. After all tasks → VERIFY everything end-to-end
6. If verification fails → add fix tasks to todo → work through them → re-verify
7. If code changed → update affected genome docs (components, flows, rules, state)
8. If code changed → mark affected modules for re-test in next verify pass
9. Loop terminates ONLY when: all tasks done + all verifications pass + docs match code
```

## Why This Exists

Three failure modes this prevents:

1. **Agent drift** — AI agents default to "summarize and stop" after completing a chunk of work, even when more work remains. The todo file is persistent — the agent reads it on every resume and knows exactly where it left off. Context compression can't erase it.

2. **Doc drift** — Code changes without doc updates create a cascading problem: future agents read stale docs, build wrong things, create more bugs. Requiring doc updates IN the same loop means drift is caught immediately, not sessions later.

3. **Silent failures** — Code gets written but never verified. Bugs compound silently. The verify step forces the agent to test its own work before declaring done. If verification reveals a bug, the loop catches it and creates fix tasks automatically.

## Loop Rules (Immutable)

Every todo loop file must include these rules at the top:

```
LOOP RULES:
1. After each task → READ THIS FILE → check for incomplete tasks → continue
2. After ALL tasks in a round → VERIFY (test end-to-end)
3. VERIFY fails → CREATE fix tasks → APPEND → re-VERIFY after fixes
4. Code changed → mark module for RE-TEST in next verify pass
5. Code changed → UPDATE DOCS (genome components, state.md, affected flows/rules)
6. NEVER stop. NEVER ask user. NEVER summarize-and-wait.
7. New issues discovered → SUB-LOOP with same rules
8. ALL DONE = every verify passes + docs match code + final verification clean
```

## Sub-Loops

When fixing a bug reveals a deeper issue, the agent creates a sub-loop:

```
Main loop task 2.3: Fix login endpoint 500 error
  → Investigation reveals: auth middleware is also broken
  → SUB-LOOP created:
    - [ ] Fix auth middleware token validation
    - [ ] Fix login endpoint error handling
    - [ ] VERIFY: both auth + login work end-to-end
    - [ ] LOOP CHECK: sub-loop done? → return to main loop
```

Sub-loops inherit all rules from the parent loop. They terminate when their own verify passes, then control returns to the parent loop.

## Safety Rails

| Rail | Purpose |
|---|---|
| Retry budget (10 max per task) | Prevents true infinite loops while allowing thorough fixing |
| Cost/time budget from parent | Hard stop if agent burns too much |
| Escalation at 15 min stuck | Agent messages parent if looping without progress |
| Sub-loop depth limit | Max 3 levels of nested sub-loops |

**Feedback loop, not infinite regression.** The ping-pong pattern (fix -> test -> find deeper issue -> fix -> test) is intentional. It is a feedback loop, not a bug. Some bugs are deep-rooted and genuinely need many iterations of back-and-forth between fixing and testing before the root cause is resolved. The retry budget of 10 prevents true infinite loops, but allows thorough fixing without artificially cutting off productive work.

**Future: pay-as-you-go budget model.** Transition from fixed retry count to Lux-based budgets. Users set a Lux budget for the task; the loop runs until the work is genuinely done or budget is exhausted. Users can top up or stop at any time. This aligns cost with value — simple fixes cost little, deep-rooted bugs cost more, but the work gets done.

## Implementation: Claude Code Todo System

**MANDATORY:** All agents MUST use Claude Code's built-in todo system (`TaskCreate`, `TaskUpdate`, `TaskList`) for tracking work. This makes progress visible to the user and other agents in real-time. The todo-loop.md file is the persistent backup — but the live tracking happens via the Claude Code task tools.

**Why both:** The Claude Code todo system is visible in the terminal UI. The todo-loop.md file survives context compression and session restarts. Use both: Claude Code tasks for live visibility, todo-loop.md for persistence across sessions.

**Pattern:**
1. Create tasks via `TaskCreate` with clear subjects and `activeForm` (shows in spinner)
2. Set dependencies via `TaskUpdate` with `addBlockedBy`
3. Mark `in_progress` when starting, `completed` when done
4. After each completion, call `TaskList` to see what's next
5. The todo-loop.md file mirrors this but adds the VERIFY and LOOP logic

## For Templates

Every agent template (genome/templates/*.md) includes the todo loop as part of its workflow:

**Manager:** Creates todo loops for each project. Uses Claude Code tasks for visibility. Verifies workers followed the pattern. Checks that docs were updated.

**Builder:** Maintains a todo loop for each assigned task. Uses Claude Code tasks so manager can track. Verification = tests pass + build succeeds + docs updated.

**Tester:** Maintains a todo loop for test suites. Uses Claude Code tasks for test case tracking. Verification = all tests run + results logged + failures reported.

**All agents:** The todo loop file lives in the agent's workspace (`~/.pando/agents/<id>/workspace/todo-loop.md`). It persists across sessions. The agent's CLAUDE.md says "read todo-loop.md on every session start." Claude Code tasks (`TaskCreate`/`TaskList`) provide real-time visibility.

## Origin

Discovered 2026-02-20 during a self-continuation experiment. CEO session maintained a 4-task loop without stopping by reading a directive file between tasks. The pattern was refined to include self-verification and doc-update steps. See `genome/history/decisions.md` for the full record.
