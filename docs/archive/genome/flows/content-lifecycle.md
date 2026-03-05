---
id: content-lifecycle
components: [content-registry, content-publish, content-maintenance, content-safety]
rules: [two-laws, qa-standard]
trigger: content_created
---

# Content Lifecycle Flow

How content is created, verified, published, and maintained on the network.

## Steps

```
1. CREATE
   Agent completes work in workspace.
   content-publish.ts extracts content from workspace output.
   → Raw content ready

2. SAFETY REVIEW
   content-safety.ts runs 5-category scan:
   - Harmful content (violence, abuse, illegal)
   - Malicious code (backdoors, data exfiltration)
   - OWASP vulnerabilities (injection, XSS, etc.)
   - Two Laws violations
   - Dependency vulnerabilities
   → Safety score 0-1. Below threshold = rejected.

3. REGISTER
   content-registry.ts creates SQLite record:
   - Title, description, type, tags, creator
   - Content hash, version, safety score
   - Revenue split: 40% host, 40% builder, 20% NETWORK
   → Content registered locally

4. BROADCAST
   GossipSub publishes to pando/content topic.
   All nodes receive and store the content record.
   Version-wins merge for updates.
   → Network-wide visibility

5. SERVE
   Content accessible via API: GET /content/:id
   Full-text search: GET /content/search?q=...
   Gateway /content page shows browseable catalog.
   → Users can find and access content

6. MAINTAIN
   content-maintenance.ts runs periodic checks:
   - Staleness detection (no updates in X days)
   - Broken link detection
   - Auto-create maintenance tasks for stale content
   → Content stays fresh

7. ARCHIVE
   Inactive content archived after configurable period.
   Archived content still accessible but not actively maintained.
   → Clean catalog
```
