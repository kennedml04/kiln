# 02: Move to top: hold or Shift on ▲

**What to build:** Build on the ▲ ▼ buttons ticket. Holding ▲ 500 ms (pointer events, touch or mouse) calls move(id, 0) and swallows the following click; release/cancel/leave before that is a normal one-step move. Shift+click, Shift+Enter and Shift+Space move to top, via event.shiftKey on click. ▲ gets title and aria-description "Hold, or Shift, to move to the top", aria-keyshortcuts Shift+Enter, touch-action none, user-select none, -webkit-touch-callout none, and prevents contextmenu. Hold on a disabled ▲ does nothing. Shell tests on the phone viewport: holding ▲ on the last card moves it to the top and only there; Shift+Enter moves to top while Enter alone moves one step.

**Blocked by:** None

**Status:** needs-triage
