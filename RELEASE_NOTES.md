# 0.2.9 — Fix cross-vault session cookie interference on mobile

This release fixes a bug where syncing a second vault on the same device
could fail with "Remote root directory does not exist" even though the
directory exists on the server.

On iOS, the native HTTP layer shares one app-wide cookie jar across vaults.
A Nextcloud session cookie set while syncing the first vault was attached to
requests for the second vault, overriding the Basic credentials and causing
404 responses for paths the second account cannot see.

The fix is platform-specific:

- iOS: requests now send an empty Cookie header, which suppresses the native
  session-cookie injection so the configured Basic credentials are honored.
- Android: no Cookie header is sent. Instead, the shared cookie jar is
  cleared once whenever the sync account (server address or username)
  changes, so a stale session from another vault cannot leak into the new
  account. Same-account sessions are left untouched.
- Desktop: behavior is unchanged from 0.2.8.

Verified on real devices: an Android vault under cross-account contamination
reproduced the 404 with 0.2.8 and converged fully (1486 files) with this
build; both iPad vaults converged in alternating contaminated sessions.
Regression suite: 682 passing, 0 failing.