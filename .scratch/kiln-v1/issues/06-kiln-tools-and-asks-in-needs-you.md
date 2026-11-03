# 06: Kiln tools and Asks in Needs you

**What to build:** Sessions talk to Kiln through the Kiln tools: an MCP endpoint the core offers each Session, scoped to that Session's Item. This ticket adds the tools to raise an Ask and to read the Item and its artifacts. An Ask is typed (Decision, Permission, Review or Question). It names its Item, says why it matters, carries a recommended answer, and is either blocking or non-blocking. A blocking Ask pauses the Session. A non-blocking Ask lets the Session carry on with its recommendation, and the person can still change the answer while the Session runs. Widgets can raise Asks through the core API too. Needs you is one inbox in the Shell holding every open Ask across Projects. It is sorted by how much work each Ask blocks (Items and Sessions waiting on it, directly or through children), with ties broken by age, and its count shows on every page. Answering delivers the answer to the Session (or Widget) that raised the Ask, and the Session resumes.

**Blocked by:** 05

**Status:** resolved

- [ ] Each Session gets Kiln tools over MCP, scoped to its own Item
- [ ] A Session raises each of the four Ask types; every Ask carries its Item, why it matters, a recommended answer and whether it blocks
- [ ] A blocking Ask pauses the Session, and answering it resumes the Session with the answer
- [ ] A non-blocking Ask lets the Session continue; changing the answer later reaches the running Session
- [ ] A Widget can raise an Ask through the API
- [ ] Needs you is sorted by how much work each Ask blocks, then by age; the badge count shows on every page and updates live
- [ ] A browser test answers an Ask in Needs you
