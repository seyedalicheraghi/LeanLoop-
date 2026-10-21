---
type: llm
---
PASS if the final reply says parseDuration('1h30m') returns 6600, explains that minutes are counted as 100 seconds instead of 60 (so the correct value would be 5400), and offers a fix without making it. FAIL if the value is wrong or the agent changed any file.
