# A Project's tooling starts in its own repo and becomes a Widget only when Kiln needs it

A Project is not a Widget. The tools a Project builds for its own work, such as room-render's render pipeline or review page, start as plain code in that Project's repo. An agent runs them inside the Project's normal Workflow. A tool becomes a Widget only when one of three things is true:

1. Kiln has to show it in the Shell.
2. Kiln has to run it as a Workflow step with no agent Session driving it.
3. A second Project needs it.

A working workflow is not on its own a reason to convert. A tool that never meets any of the three stays in its Project.

The reason is that the right shape is unknown until the tool has done real work. Early Stories are spikes with time boxes and fallback routes. A Widget fixes a manifest, an interface and an install path around a guess, and adds the Widget host, the SDK and the install to every bug hunt.

To keep the later conversion cheap, Project tooling is written from the start as a CLI. It takes files and ids in and writes files and a result out. It does not rely on chat context, and it uses no paths outside its repo. A Widget is then a wrapper around that CLI, not a rewrite.

The exception is anything that only exists inside Kiln: Agents (see 0004), board views and the Shell's own pieces. These are built as Widgets from the start, because there is nothing to prove outside Kiln.
