# NextClaw Sync 0.2.4

- The first Android account sync can download up to eight ordinary remote-only files concurrently in a new vault. Guarded local writes remain limited to four concurrent operations. Each publication retains remote file identity and version checks and protects occupied local paths.
- First-sync Android GIF and PNG imports use a separate content budget, with a 50 MiB per-file limit and one attachment at a time. Previously deferred downloads can resume, and verified clean files can be reused without downloading their bodies again.
- In a test with a fixed snapshot containing 1,485 ordinary files on a MacBook Android 15 emulator, the full vault converged and the designated note opened after automatic reload in 7 minutes 0 seconds. Independent verification passed. Times depend on the device, snapshot and network.
