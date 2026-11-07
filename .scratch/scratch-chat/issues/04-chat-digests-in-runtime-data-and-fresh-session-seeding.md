# 04: Chat Digests in runtime data and fresh-Session seeding

**What to build:** Write chat Digests to <dataDir>/chats/<id>/digests/ (same markdown format, never the Knowledge store); one live Session per chat, a Digest on idle, and after cache expiry start a fresh Session seeded from the chat's Digests plus the new message, never the transcript; context alarm continues fresh.

**Blocked by:** None

**Status:** in-review

**Stage:** implementing
