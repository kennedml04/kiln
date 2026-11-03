# 20: Widget panels, events and secrets

**What to build:** What a Widget can offer and use beyond running.

- **Declarative panels.** A Widget publishes a declarative panel description (cards, tables, stats, and buttons bound to its named actions). The Shell draws it where the Manifest says, patches it live when it changes, and routes button presses back to the Widget as actions.
- **Sandboxed pages.** A rich Widget instead declares an embedded page. The Shell loads it sandboxed, with no access to the Shell's origin, cookies or other Widgets, and it talks only to its own Widget through a message bridge.
- **Events.** Widgets subscribe to typed core events (Item moved Stage, Session started, paused or finished, Ask raised or answered, usage updated, Widget health changed) within their grants.
- **Secrets.** Secrets the Manifest declares are entered by an Admin, kept by the Platform in the OS credential store (never in SQLite or plain files), and handed only to that Widget.
- **SDK.** The TypeScript Widget SDK gains panel helpers and an event subscription client.

**Blocked by:** 19

**Status:** resolved

- [ ] A declarative panel appears in the Shell, updates live, and its buttons trigger the Widget's actions
- [ ] An embedded page runs sandboxed and can't reach the Shell's cookies or DOM, or other Widgets
- [ ] A Widget receives subscribed events, and only those its grants allow
- [ ] A declared secret is stored in the OS credential store and is readable only by its Widget
- [ ] A browser test covers a declarative panel
