(no output expected — archived session is skipped)

Sessions with time_archived IS NOT NULL are excluded from enumerate().
The snapshot test for this scenario verifies that enumerate() yields zero SessionHandles.
