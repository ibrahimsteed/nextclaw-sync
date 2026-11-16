# NextClaw Sync 0.2.1

- Two-way sync uses file contents to distinguish edits from unchanged files. It can merge non-overlapping Markdown edits and preserves overlapping edits with conflict markers for review.
- File deletions check the last synced version. An edit on the other side is preserved. Directory deletions and suspected renames remain pending. An unresolved rename collision can defer deletions of other files in the same vault.
- Android save-triggered sync skips repeated downloads for files verified clean by remote file ID, strong ETag, and a local content hash. Periodic sync still verifies remote contents. Android does not automatically send WebDAV `MOVE` requests for renames.
- An unknown native write result keeps subsequent writes paused across plugin reload and app restart. Preserve the files and sync records for investigation.

## Verification and limits

Android testing used stock Obsidian in an emulator with an isolated Nextcloud vault and Nextcloud Files Desktop as a sync peer. It covered saved edits, periodic discovery, deletion and rename protection, and persistence of an unknown-write pause across reload and restart.

A physical iPad was tested for first sync, unchanged saves, a single-note edit, Obsidian restart recovery, periodic discovery, file deletion, deletion competing with an edit, and suspected-rename handling for a rename initiated on the iPad. The iPad lost-response `PUT` scenario remains unverified. The Android download optimization was measured on Android only. This release has no new desktop end-to-end verification or 24-hour stability result.
