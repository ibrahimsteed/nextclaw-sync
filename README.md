# NextClaw Sync

Sync your Obsidian vault with Nextcloud or any other WebDAV server, on desktop and
mobile. NextClaw accounts sync on iPad and Android tablets only — see below.

NextClaw Sync is made for NextClaw accounts: the
server address is filled in for you, and a read-only demo vault works before you
enter anything. It is still a general WebDAV sync plugin — point it at your own
Nextcloud or any WebDAV service and it works the same way.

## Accounts and payment

- **Demo vault:** free, no account needed.
- **Syncing your own vault:** needs an account on a WebDAV server.
  - A **NextClaw account is a paid service**, and it syncs on **iPad and Android
    tablets only**. On Windows, macOS and Linux the plugin does not sync a
    NextClaw account and says so in the settings; the demo vault and other
    WebDAV servers work normally on desktop.
  - Any other WebDAV server (for example your own Nextcloud) works free of charge
    as far as this plugin is concerned. Change the server address in the settings.

The plugin itself has no paid features, no ads and no telemetry.

## Try it before configuring anything

Most sync plugins ask you to fill in four fields correctly before you can see
anything happen. This one ships with a **read-only demo vault** already
configured: install it, tap sync once, and you have a real vault to look at.

When you are ready, fill in your own username and password — the plugin switches
to your own storage and starts syncing two-way. Nothing else to set up.

After the first successful sync of the demo vault, and again after the first
successful sync of your own storage, the plugin reloads Obsidian once (without
saving) so that the downloaded settings and plugins take effect.

## Network use — please read

**This plugin talks to the network. Here is exactly when, and to where.**

**With the username field empty**, the plugin connects only when you tap sync. It downloads a small public
read-only demo vault from NextClaw's Nextcloud server, `cloud.nextclaw.chat`. Nothing is uploaded, and demo
mode never syncs automatically. The demo vault is reached through a public share link, not an account; the
server rejects every write to it.

**Once you fill in your own username**, the plugin syncs your vault in both directions with your server: on
startup (after a short delay), every 10 minutes, a few seconds after you stop editing, and whenever you tap
sync. For a NextClaw account this is `cloud.nextclaw.chat`; the server address is filled in from your username.
On desktop, a NextClaw account is not synced at all and no request is sent.

**The plugin sends nothing else anywhere**: no telemetry, no analytics, no other destinations.

**You are not locked to our server.** Open "Other WebDAV services" in the settings to enter the address of any
WebDAV service you like, such as your own Nextcloud.

## Switching to your own storage — read before you fill in a username

The first sync after you enter a username **moves everything in the vault except
the `.obsidian` settings folder into the vault's `.trash` folder**, then downloads
your own storage. This keeps the demo content from being uploaded into your
account.

Install the plugin in a **new, empty vault**. If you install it in a vault that
already contains your notes, those notes will be moved to `.trash` at the switch
(they are recoverable from there, but they will not be synced). Before that happens,
the plugin asks you to confirm and lists what will be moved; it also warns you before
the first demo sync replaces the settings of a vault that already has files.

## The `.obsidian` settings folder

Settings and plugins inside `.obsidian` are **downloaded from the server and never
uploaded**. The server's copy is authoritative: when it changes, it replaces the
local copy. Plugins you install yourself stay on your device, stay enabled, and are
never uploaded or removed. Window layout files (`workspace*.json`) are not synced.

## Deleted files

Deletions go to the vault's own `.trash` folder, not the device's system trash.
On mobile the system trash is not reliably available, and `.trash` is somewhere
you can actually reach. It is a hidden folder, so it is never synced to the
server — but it is also never cleaned up automatically. Delete it yourself if it
grows.

## Conflicts

If the same note changed on both sides since the last sync, the newer
modification time wins. When the server's version wins, your local version is first
moved to `.trash`. When your version wins, the server's version is overwritten —
keep a server that retains file versions (Nextcloud does by default) if that
matters to you.

Deletions propagate: a note deleted on one side is deleted on the other, unless it
was modified there in the meantime, in which case the modified copy is kept.

## Your password

Your username and password are stored in this plugin's `data.json` inside the
vault's `.obsidian` folder. The file is obfuscated, not encrypted: anyone who can
read your vault folder, or another plugin, can recover them. Use an app password
where your server supports it.

## Troubleshooting

Settings → NextClaw Sync → Diagnostics → **Export sync plans** writes recent sync
plans as notes into the `_nextclaw_debug` folder. That folder is never synced.

## Licensing and origin

Apache License 2.0. See [`LICENSE`](LICENSE).

NextClaw Sync started as a fork of
[Remotely Save](https://github.com/remotely-save/remotely-save) (Apache License
2.0). The sync engine has been rewritten, and support for services other than
WebDAV, end-to-end encryption and settings import/export have been removed.
