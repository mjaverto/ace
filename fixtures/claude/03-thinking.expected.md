---
source: claude
sessionId: c3d4e5f6-a7b8-9012-cdef-345678901234
title: Explain the trade-offs between using a database index and a full table scan.
startedAt: 2026-05-01T12:00:00.000Z
endedAt: 2026-05-01T12:00:08.000Z
cwd: /Users/example/project
model: claude-opus-4-5
gitBranch: main
version: 1.2.3
messageCount: 2
toolCallCount: 0
aceSchema: 1
aceRenderedAt: <RUNTIME>
sourcePath: <RUNTIME>
sourceMtime: <RUNTIME>
---

# Explain the trade-offs between using a database index and a full table scan.

## User · 2026-05-01T12:00:00.000Z

Explain the trade-offs between using a database index and a full table scan.

## Assistant · 2026-05-01T12:00:08.000Z

<details><summary>thinking</summary>

The user wants to understand when indexes help vs when they hurt. I should cover selectivity, write overhead, and the optimizer's choice. I'll mention the crossover point where a full scan is faster for low-selectivity queries.

</details>

Great question. Here are the key trade-offs:

**Database Index**
- Fast for high-selectivity queries (few matching rows)
- Adds write overhead on INSERT/UPDATE/DELETE
- Consumes additional storage
- Most effective when returning < ~10% of rows

**Full Table Scan**
- Efficient when returning a large fraction of rows
- Sequential I/O is faster than random I/O for spinning disks
- No maintenance cost
- Preferred by the query planner for low-selectivity predicates

The query planner chooses between them based on statistics about data distribution.

