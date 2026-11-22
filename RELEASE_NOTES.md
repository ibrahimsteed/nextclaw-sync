# 0.2.8 — Restore the 0.1.13 sync engine

This release restores the NextClaw Sync implementation from 0.1.13
(`62d1dc4`). It keeps the existing plugin ID and uses a higher version number
so the community directory can distribute the rollback.

The 0.1.13 behavior includes conflict copies, follow-up sync after continued
editing, deferred directory deletion, and a pause when the outcome of a
native write cannot be confirmed.
