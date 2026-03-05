---
id: genome-update
components: [genome-agent, agent, agent-manager, manager]
rules: []
trigger: git_commit | periodic_check | manual
---

# Genome Update Flow

How the Project Genome stays in sync with code reality.

## Steps

```
1. TRIGGER
   A git commit lands, or a periodic check runs, or a manager requests drift detection.

2. ANALYZE (GenomeAgent)
   GenomeAgent.getRecentCommits() fetches recent git log entries.
   For each commit: analyzeCommit(hash) extracts changed files via git diff-tree.

3. MAP (GenomeAgent)
   mapFilesToComponents(files) matches changed files against component entry fields
   in genome.yaml frontmatter. Returns ComponentMatch[] with direct matches.

4. RESOLVE DEPENDENCIES
   For each matched component, parse frontmatter to get depends_on list.
   Mark both the matched component and its dependencies as potentially affected.

5. DETECT DRIFT (GenomeAgent)
   detectDrift() scans ALL components for:
   - Missing source files (entry field points to deleted file)
   - Missing genome .md files (genome.yaml lists file that doesn't exist)
   - Broken dependency references (depends_on points to non-existent component)
   Returns DriftIssue[] with severity (error/warning).

6. DETECT NEW FILES (GenomeAgent)
   detectNewFiles() scans packages/node/src/ for .ts files
   not tracked in any component's entry field.
   These are candidates for new genome component entries.

7. REPORT TO MANAGER
   Drift issues are injected into the manager's event prompt via
   buildPromptFromBridgeItem() for task_completed events.
   Manager decides: update genome (code is right) or fix code (genome is right).

8. SCOPED CONTEXT FOR WORKERS
   When a task is created and a workspace is built, the GenomeAgent provides
   scoped context via getScopedContext(). This is injected as Layer 8 in the
   worker's CLAUDE.md, giving the worker focused architecture knowledge.
```

## Scoped Context Algorithm

```
Input: taskDescription, affectedFiles, maxComponents (default 8)

1. Match affectedFiles against component entry fields -> direct matches
2. For each direct match, resolve depends_on (1 level deep) -> dependency matches
3. Keyword-match taskDescription against component/flow summaries -> keyword matches
4. Find flows whose components field references any matched component -> flow matches
5. Collect rules referenced by matched components and flows -> rule matches
6. Cap total components at maxComponents (direct > deps > keywords)
7. Read .md file content for all matched items
8. Return ScopedGenomeContext { components, flows, rules, summary }
```

## Error Handling

- Git commands timeout after 10 seconds. If git is unavailable, return empty results.
- Missing genome files are reported as drift issues, not exceptions.
- Frontmatter parsing failures are silently skipped (returns empty object).
- Scoped context generation failures are non-critical -- workspace creation proceeds without Layer 8.

## Cost

Zero. All operations are local filesystem and git commands. No API calls.
