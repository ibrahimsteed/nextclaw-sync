# NextClaw Sync 0.2.3

- Speeds up the first switch from the read-only demo vault to an account vault on Android. Ordinary remote-only files can download and be written in bounded parallel groups. Remote version checks and local overwrite protection remain in place.
- After the first successful switch and automatic Obsidian reload, one recovery run checks clean files without downloading their bodies again when their versions and local content still match.
- In an Android app-storage test with 1,419 ordinary files, the full vault synced and the designated note opened after automatic reload in 9 minutes 20 seconds. This was a test with one fixed snapshot and network environment.

Suspected renames stay pending on Android. The plugin does not automatically send WebDAV MOVE requests for them. While a rename collision is unresolved, deletion of other files in the same vault may also be deferred. The first-sync performance result applies to the tested Android environment.
