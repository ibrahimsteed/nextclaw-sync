# NextClaw Sync 0.2.7

- Daily account sync on Android and iPad now reuses clean-file verification on scheduled and startup syncs, and on Android save-triggered syncs.
- Mobile daily sync verifies up to eight ordinary files in a rolling queue, starting the next file as soon as a slot opens.
- Sync reuses remote file versions from the current listing when the vault’s strong collection ETag remains unchanged. If that check fails, sync verifies remote versions file by file. Local content checks and protected writes remain in place.

In a static 1,485-file vault, the listing-based check reduced a daily sync from 159.3 to 41.2 seconds on a physical iPad and from 94.7 to 20.2 seconds on an Android emulator, compared with the eight-lane rolling queue using per-file probes. WebDAV PROPFIND requests fell from 2,992 to 23 on both. These measurements cover a single unchanged-vault sync per build and platform.
