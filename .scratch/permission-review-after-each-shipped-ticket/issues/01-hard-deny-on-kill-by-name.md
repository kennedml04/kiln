# 01: Hard Deny on kill-by-name

**What to build:** Spec section 1. In onPermissionRequest (packages/core/src/flow/session-manager.ts), beside the CO_AUTHORED_BY check and before decide, refuse any request where killsByName is true: no Ask, whatever the Policy layers or allow rules say. Send the Session a session.message from Kiln (kill only processes you started, by PID). Audit as permission.deny, actor Kiln, outcome refused, by:'kill_by_name'. Killing by PID is unchanged. The review reads those audit entries and warns '"<command>" was refused: it kills processes by image name…' (warnings never raise an Ask alone). Tests via startTestKiln + fake Agent: taskkill //F //IM node.exe, pkill node, Stop-Process -Name node, Get-Process node | Stop-Process, kill $(pgrep node) denied even with allow rules; taskkill /PID 1234 and kill 1234 still follow the Policy; works in Project Thread/chat Sessions.

**Blocked by:** None

**Status:** needs-triage
