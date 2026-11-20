# NextClaw Sync 0.2.5

- First account sync on Android and iPad can download up to ten eligible remote-only files concurrently. Guarded local writes retain their four-operation limit and version checks.
- Android and iPad apply a 50 MiB per-file limit and a 1,000 MiB content budget during daily account sync. Eligible larger files retain guarded downloads and conditional uploads.
- During interrupted content recovery, independently confirmable operations can finish in one pass before a single rescan. An operation that cannot be confirmed still stops recovery.
