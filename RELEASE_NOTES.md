# 0.2.10 — Account address template matches the hosted vault layout

The server address auto-filled for a NextClaw account now includes the
`data/` path segment:

```
https://cloud.nextclaw.chat/remote.php/dav/files/<username>/data/Documents
```

On the NextClaw host, the Nextcloud Files Desktop sync root is
`/home/ctyun/customers/<username>` and the vault lives at
`<sync root>/data/Documents/ObsidianVault_Math`. With the previous template
(`.../files/<username>/Documents`) the synced vault landed one level too
high, so users had to edit the address by hand. The new template fills in
the correct address directly; the remote folder stays `ObsidianVault_Math`.

Everything else is unchanged:

- The address field remains editable. An address you changed yourself is
  never overwritten when the username changes.
- The read-only demo vault (no username) is unaffected.
- Other WebDAV servers are unaffected.
- The cross-vault session cookie fix from 0.2.9 is included.

Regression suite: 682 passing, 0 failing.