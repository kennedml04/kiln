# 14: Scheduler, pools, priority and Stop all

**What to build:** Sessions no longer start immediately. They queue for room in their Stage's named capacity pool (default "agents: 3"). Widgets can add pools later through their Manifest. The queue is ordered by Item priority, then by age, and a person sets priority by dragging Items within Up next on the board. An Admin can change a pool's size from the Shell. A Stop all button sits in the persistent header. After a confirmation, it pauses every running Session and halts dispatch until a person resumes. Nothing is killed, and paused work can resume.

**Blocked by:** 05

**Status:** resolved

- [ ] No more Sessions run at once than their pool allows; the rest wait in Up next
- [ ] Dragging within Up next changes the start order, and the board shows it live
- [ ] Changing a pool's size takes effect without a restart
- [ ] Stop all asks for confirmation, then pauses every Session and the queue; resuming continues the work
- [ ] A browser test covers Stop all
