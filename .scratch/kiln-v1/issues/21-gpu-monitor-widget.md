# 21: GPU monitor Widget

**What to build:** The first Widget ported from the old board, proving the Widget contract end to end. It is installed from the public repo like any other Widget. It draws a read-only declarative panel showing each GPU's use, its VRAM, and the processes holding it, read through the vendor tools, and it updates live. Its Manifest declares the "gpu: 1" capacity pool, so GPU-bound Sessions never run two at a time. It takes no actions on the GPU: no unloading and no preparation.

**Blocked by:** 14, 20

**Status:** resolved

- [ ] Installed through the normal install and approval flow
- [ ] The panel shows GPU use, VRAM and holding processes, updating live
- [ ] The "gpu: 1" pool from its Manifest is enforced by the scheduler
- [ ] Stopping or crashing the Widget doesn't affect the core or other Widgets
- [ ] The panel has no controls that change GPU state
