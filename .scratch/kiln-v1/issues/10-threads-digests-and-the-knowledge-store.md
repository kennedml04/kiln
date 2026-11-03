# 10: Threads, Digests and the Knowledge store

**What to build:** Each Item has one Thread showing all its Sessions and messages in order, across every Stage. A person types into the Thread and the message reaches the Item's current Session, or starts a fresh Session for the current Stage if none is running. Every Session writes a Digest when it ends (Stage exit, Gate answered, or chat gone idle), using a Kiln tool. The Digest records what was decided, what changed and what is still open. Fresh Sessions are seeded from the Item's artifacts plus its Digests, never from a raw transcript. Once an Item's Digests pile up, they are rolled up into one. A Session that comes back after its Agent's reported cache lifetime has passed starts fresh from Digests. Digests live in the Knowledge store, which by default is a markdown folder with frontmatter that can be read as an Obsidian vault. The Thread keeps streaming while the person selects text or scrolls.

**Blocked by:** 06

**Status:** resolved

- [ ] An Item's Thread shows every Session across its Stages in order
- [ ] A Thread message reaches the running Session, or starts a fresh one when none is running
- [ ] Every Session end writes a Digest to the markdown Knowledge store
- [ ] A fresh Session's seed contains the artifacts and Digests and no raw transcript
- [ ] Digests are rolled up when an Item has too many, and seeding uses the rollup
- [ ] A resume after the cache lifetime has passed starts a fresh Session from Digests
- [ ] A browser test confirms that streaming keeps text selection and scroll position
