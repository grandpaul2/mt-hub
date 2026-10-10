# Hub dialogs: conventions research and layouts (Admin, Voice, Sound)

Research only; no hub files were changed. Written 2026-10-04 against `~/mt-hub/docs/style-guide.md` (S43-S49)
and `web/src` (`style.css`, `util.ts` openDialog, `admin.ts`, `voice.ts` openSettings, `sounds.ts`).

Labels: **strong** = most systems agree. **One system** = one app's style, adopt only if it suits us.

Source reliability: GNOME, Microsoft Learn, Material, NN/g, Carbon and Smashing were fetched. The Apple pages came back
as a summary only. Discord, Slack and GitHub layouts come from help articles and third-party guides (I did not
open those apps), so treat the details of their exact current UI as approximate.

---

## 1. Why the three dialogs look amateur (from the screenshots and CSS)

- **No row structure.** Voice uses a 150 px label column plus loose controls; Sound uses a bold run-in title followed by
  a description in the same line; Admin is a table with a heading, then loose forms. Three dialogs, three layouts.
- **Controls wrap or collide:** "+0 dB" wraps, "Mic Test" wraps to two lines, the select truncates
  "DeepFilterNet3 (best…", the echo checkbox label is a 2-line sentence.
- **Help text sits in the wrong place:** the gate paragraph is detached from its slider (it sits below it with the same
  weight as a label).
- **Colour overuse:** Admin has two solid red buttons on every row plus two blue buttons (Add account, Make admin).
  Voice's "Stop Test" turns red (the guide reserves red for destruction).
- **Blue "Done" with nothing to confirm** (guide 3.2: blue marks the one thing to do next; instant-apply dialogs have none).
- **Inconsistent spacing:** padding 22, gaps 10/14/6/4, margins hand-set per dialog (`margin-left:160px` on the meter).

---

## 2. Conventions

### 2.1 Settings layout

| # | Convention | Strength | Sources |
|---|---|---|---|
| S1 | **A setting is a row: title (and optional subtitle) on the left, the control on the right.** The row, not a label column, is the unit. Windows' SettingsCard: header + description + action control aligned right. libadwaita's rows: title, subtitle, suffix children. Discord Voice & Video and Slack Preferences read the same way (label/description left, control under or right). | strong | [libadwaita boxed lists](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/boxed-lists.html), [GNOME HIG boxed lists](https://developer.gnome.org/hig/patterns/containers/boxed-lists.html), [Windows app settings guidelines](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings), [SettingsCard](https://winuicommunity.github.io/winUICommunityComponents/controls/settingsCard/) |
| S2 | **Subtitle = the explanation, placed with the setting it explains.** Helper text is a muted second line under the title, not a paragraph floating below a control. | strong | same as S1; VS Code's Settings editor shows title + description above each control ([VS Code settings](https://code.visualstudio.com/docs/configure/settings)) |
| S3 | **Group related rows under a short section heading;** the heading is small and muted, with space above it and little below. (Windows: "group similar or related settings under one section header"; libadwaita: PreferencesGroup with title and optional description.) | strong | Windows guidelines, libadwaita (above). Our own 11 px uppercase muted heading (guide 6.4/7) is the same idea |
| S4 | **Controls are right-aligned in one column** with a consistent width, so the eye runs down the edge. Windows: "built-in logic ... minimum widths and right-aligned controls". | strong | Windows SettingsCard docs |
| S5 | **One or two controls per row, at most.** libadwaita: "controls should be limited to one or two per row". A slider + readout + Test button is the upper limit. | one system (GNOME) but matches the rest | [GNOME HIG boxed lists](https://developer.gnome.org/hig/patterns/containers/boxed-lists.html) |
| S6 | **Rows are separated by 1 px hairlines or by card edges, not by boxes inside boxes.** GNOME draws boxed lists (rounded card, hairlines); Discord, VS Code and Slack use flat rows with hairlines or whitespace. | split: GNOME/Windows use cards; Discord/VS Code are flat | libadwaita, Windows; VS Code |
| S7 | **Show a value readout next to a slider** with a fixed width so it never wraps or shifts (Discord's volume sliders show the number; GNOME scales support a value label). Do not make the label share the slider's width. | strong in practice | Discord Voice & Video ([guide](https://www.howtogeek.com/663414/how-to-configure-your-microphone-and-headset-in-discord/)); our own `.pct` readout in Sound already does this |
| S8 | **Test/preview buttons sit with the thing they test, and the live meter sits with the test.** Discord: "Let's Check" under the volume sliders, button toggles to "Stop Testing". Slack: "Show an example" in Sound & appearance. | strong | [Discord guide](https://www.howtogeek.com/663414/how-to-configure-your-microphone-and-headset-in-discord/), [Slack notification settings](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications) |
| S9 | **Label the toggle with what it controls, 1-2 words or a short noun phrase;** long conditions go in the subtitle. Windows: "label it with one or two words, preferably nouns". | strong | [Windows toggles](https://learn.microsoft.com/en-us/windows/apps/design/controls/toggles) |
| S10 | **Instant apply means no Save button** and settings should have working defaults. | strong | [Apple Settings](https://developer.apple.com/design/human-interface-guidelines/settings) (summary page), VS Code ("changes apply immediately"), [Windows toggles](https://learn.microsoft.com/en-us/windows/apps/design/controls/toggles) |
| S11 | **Progressive disclosure for rare/advanced options:** a row that expands (Windows SettingsExpander, GNOME expander row), or a separate Advanced section (Discord has an Advanced tab for voice). Keep nesting to one level. | strong | [SettingsExpander docs](https://github.com/CommunityToolkit/Windows/blob/main/components/SettingsControls/samples/SettingsExpander.md), Discord voice guide |
| S12 | **VS Code marks a modified setting** with a coloured left bar and a gear menu with "Reset". | one system (VS Code) | [VS Code settings](https://code.visualstudio.com/docs/configure/settings) |

### 2.2 Dialog frame

| # | Convention | Strength | Sources |
|---|---|---|---|
| D1 | **Width 280-560 dp, padding 24 dp.** Material dialogs: 24 dp padding all round, width range 280-560. | strong (Material is the only hard numbers; Windows/GNOME give none) | [Material 3 dialogs](https://m3.material.io/components/dialogs/guidelines) |
| D2 | **Cancel/safe action first (left), affirmative last (right)** on GNOME, Material, and ours; Windows puts the "do it" button on the left. We already use cancel-left (guide 6.5). | split by platform; ours matches GNOME/Discord/Web | [GNOME dialogs](https://developer.gnome.org/hig/patterns/feedback/dialogs.html); [Windows dialogs](https://learn.microsoft.com/en-us/windows/apps/design/controls/dialogs-and-flyouts/dialogs) |
| D3 | **Name the affirmative button for what it does** ("Save", "Delete"), not "OK"/"Done". GNOME says so explicitly. For instant-apply dialogs there is no affirmative: use a close control. | strong | GNOME dialogs, Windows dialogs ("specific responses ... can be understood more quickly") |
| D4 | **Esc is the safe close** in every system; the safe action always exists. | strong | Windows dialogs ("CloseButton ... ESC"), our guide 6.5 |
| D5 | **Don't use a dialog for contextual errors; show them inline** next to the field. | strong | Windows dialogs |
| D6 | **A destructive confirm is a dialog or an undo, and undo is better** because people skip the text. We have no undo (guide 6.6), so the dialog stays. | strong | GNOME dialogs |
| D7 | **Modal dialogs suit a short, necessary decision; minor preferences belong elsewhere** (a page or non-modal panel). | strong | [NN/g](https://www.nngroup.com/articles/modal-nonmodal-dialog/) |
| D8 | **Instant-apply dialogs close with a header "X" (Discord's settings: X plus Esc) or a plain "Close", not a primary button.** | strong in practice (Discord, Slack, VS Code have no footer button) | Discord and Slack settings; Windows "Close" guidance |

### 2.3 Toggle vs checkbox (question 4)

- **Strong convention: switch for an on/off setting that takes effect immediately; checkbox when the user must press
  Submit/OK, for optional items, or for picking several items in a list.** ([Windows toggles](https://learn.microsoft.com/en-us/windows/apps/design/controls/toggles),
  [Apple toggles](https://developer.apple.com/design/human-interface-guidelines/toggles) summary, libadwaita ships `AdwSwitchRow` for exactly the settings-row case.)
- Windows' reason: with a checkbox, "the user needs to think about whether the lights are on now or whether they need to
  check the box to turn the lights on."
- All three of our dialogs apply instantly, so the on/off controls should be switches. The member picker's checkbox list
  (guide 14) stays as checkboxes (multi-select, with a confirm).
- Our guide already says "each with a switch" (8, Sound Settings); the code still draws checkboxes.

### 2.4 Member and admin lists

| # | Convention | Strength | Sources |
|---|---|---|---|
| A1 | **Per-row actions in an overflow "..." menu; the most common action may stay visible.** Discord Members: hover a row, "..." offers Timeout, Kick, Ban. GitHub People: kebab (or role dropdown) with "Remove from organization". Carbon data tables: row overflow menu, and use inline icon buttons when fewer than three actions. | strong | [Discord moderation guide](https://www.groovypost.com/howto/kick-or-ban-someone-on-discord/), [GitHub docs](https://docs.github.com/en/organizations/managing-membership-in-your-organization/removing-a-member-from-your-organization), [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/) |
| A2 | **Destructive items go last, after a separator, in red text; solid red is for the confirmation step only.** (Several design-system sources: red on thirteen buttons means red stops meaning "irreversible".) | strong among current systems; the sources are mostly issues/blogs rather than formal specs | [UX Movement](https://uxmovement.com/buttons/how-to-design-destructive-actions-that-prevent-data-loss/), [Smashing](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/), design-system issue threads from the search |
| A3 | **Hover-revealed "..." (Discord) vs always-visible (Carbon default: "persistent on each row").** | split. Always-visible is safer for keyboard and non-technical users | Discord guide; Carbon |
| A4 | **Confirm before executing**, with the name of the person and what happens; ban offers "delete messages?" and a reason on Discord. | strong | Discord guide, UX Movement, GNOME |
| A5 | **Role badges are small pills next to the name** (owner, admin); one colour per role. | strong (Discord role colours; GitHub shows "Owner" labels in some views) | our `--owner`/`--admin` tokens already do this |
| A6 | **Add/invite sits at the top of the list** (Discord "Invite", GitHub "Invite member" above People), not under it. | strong (my reading of both products; not confirmed in the fetched docs) | GitHub docs flow starts from People page |
| A7 | **Bans are a separate view on Discord** (Server Settings > Moderation > Bans, with unban). For 15 people a banned row in the same list with a "banned" badge and "Unban" in its menu is simpler. | one system (Discord); scale differs | [Discord moderation guide](https://www.groovypost.com/howto/kick-or-ban-someone-on-discord/) |
| A8 | **Danger zone at the bottom of a settings page, red border, each action described.** Only for irreversible, page-level actions; "don't create a danger zone just to have one". | strong for settings pages (GitHub); not for per-person actions | [Smashing](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/) |
| A9 | **Audit log is its own place** (Discord: Audit Log tab; GitHub: org audit log), newest first, with actor, action, target, time. Ours is 5-20 lines, so a compact section at the bottom is enough. | strong that it is separate from the member list | general; Discord/GitHub |

### 2.5 Full settings page vs small dialogs (question 3)

- **Discord:** User Settings is a full-screen overlay with a left nav (My Account, Voice & Video, Notifications ...), a close "X" with Esc label top right. Voice & Video uses stacked sections: Input Device, Input Volume, Let's Check, Input Mode, Sensitivity, then an Advanced tab. ([guide](https://www.howtogeek.com/663414/how-to-configure-your-microphone-and-headset-in-discord/))
- **Slack:** Preferences opens as a pop-up window with a left column of sections (Notifications, Sidebar, Audio & video ...). Not full-screen. ([Slack](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications))
- **VS Code:** Settings is an editor tab (search + table of contents), not a modal; modals are only for questions.
- **GNOME:** Preferences is a window with pages (sidebar when there are many, tabs/stack for a few); dialogs are for decisions.
- **Rule of thumb (strong):** a nav appears when there are more than roughly 5-6 sections; below that, one scrolling page with group headings; modals are for a single decision (NN/g, D7).
- We have: Voice (6 settings), Sounds (2 sounds), plus tiny forms (Minecraft Name, Change Password), Admin.

---

## 3. Fit with our style guide

### 3.1 Fits as is

- Dark tokens, Noto Sans, scale 11-12-13-14-15-16-22, radii 4/6, one blue primary, grey otherwise, red for destruction.
- Cancel left, confirm right; Esc closes; title 16 px; error line; sentence case.
- Menus (6.3) with Esc and arrows, Title Case items, separators: the "..." menu reuses it.
- 11 px uppercase muted section heads (6.4/7): the group headings.
- Hairline `--border`, `--bg` input fill, `--select` hover, `--ok` meter, `--owner`/`--admin` badges.
- Sound Settings description in 8 (switch, slider, tick at 70%, Test) is exactly the layout below.
- "No text glyphs as icons": use the stroke icon set for the "..." and close X.

### 3.2 Guide changes for Paul to approve

1. **Medium dialog width: 520 px** (add to 6.5 beside 380 and 720). Voice, Sound and Admin all use it. If Settings merges (section 6), that one is 680.
2. **Dialog padding 24 px and a spacing scale 4 / 8 / 12 / 16 / 24** (today 22 and ad hoc 6/10/14). Dialog gets a header row: title left, close X (tooltip "Close (Esc)") right.
3. **Instant-apply dialogs have no confirm button** and so no blue one: close via X or Esc, with an optional grey "Close". Clarifies 3.2 / 6.5 (today Voice and Sound show a blue "Done").
4. **Settings row anatomy** (new 6.8): title 13 px `--text`, subtitle 12 px `--muted`, control right, row min-height 48 px, hairline between rows, group head above. See section 5.
5. **Switch for instant-apply on/off, checkbox only for lists with a confirm** (new line in 6.2). Adds a switch control spec (section 5.1) and a select spec (`--bg`, 1 px border, 4 px, 28 px high).
6. **Admin row actions:** Reset password, Ban, Delete move into a "..." menu (6.3), destructive items red text after a separator. In 6.6 the click-twice shortcut stays but works inside the menu item ("Ban? Click again" and the menu stays open); red fill appears only on the armed state. Add to 3.3: "red text for destructive menu items".
7. **Admin dialog structure:** add at top, accounts list as rows, activity log last (list in 5.1). Admin dialog drops from 720 to 520 px.
8. **If merged:** 8's "Sound Settings" and "Voice Settings keeps the microphone only" become two sections of one Settings dialog (6, 8, and the account menu list in 2).
9. **Optional:** a danger zone is not added (nothing page-level to put in it).

No change needed: the red/blue rules (they are currently broken by the code: Stop Test red, Make admin blue beside Add account, Done blue). Those are code fixes.

---

## 4. Code fixes that need no guide change

- "Mic Test" to "Mic test" (sentence case, 11); "Stop Test" grey, not red (3.3).
- "Make admin" grey (one blue per surface); keep "Add account" blue.
- `Failed (n)` in admin errors to "Couldn’t ..." (11).
- Presence: "online" dot in Admin is last-seen info, which is fine, but keep it out of rows elsewhere (1.8).

---

## 5. Concrete layouts

### 5.0 Shared parts

**Frame** (`#dialog.settings`, 520 px, `max-width: calc(100vw - 32px)`):
- Padding 24. Radius 6, `--panel`, float shadow (as now).
- Header: flex row, `align-items:center`, title 16 px/600 left, close X icon button (24 px target) right, margin-bottom 16.
- Body scrolls if taller than `100vh - 48`; header stays fixed (sticky) so X never leaves.
- Footer: none for Voice and Sound. Admin: none either (X + Esc). A footer exists only for dialogs with a confirm.

**Spacing scale:** 4 (icon gaps) / 8 (control gaps, heading to first row) / 12 (row padding) / 16 (header to body) / 24 (frame padding, between groups).

**Group:** `h3` (11 px, 600, uppercase, letter-spacing .06em, `--muted`), margin `24px 0 8px` (first group 0 top). Rows below, no card.

**Row:** `display:grid; grid-template-columns: 1fr auto; column-gap:16px; align-items:center; min-height:48px; padding:12px 0; border-top:1px solid var(--border)` (first row of a group has a top border; last row none extra).
- Title: 13 px `--text`, line-height 18 px.
- Subtitle: 12 px `--muted`, line-height 16 px, margin-top 2, may wrap (never "..."; guide 4).
- Control cell: right-aligned, `flex-shrink:0`. Widths: select 220; slider 160 + readout 52; switch 36x20; button min-width 72, `white-space:nowrap`.
- Slider readout: 12 px `--chat-muted`, right-aligned, fixed 52 px, tabular figures, so "+24 dB" and "70%" never wrap.
- Narrow (under 560 px viewport): grid becomes one column, control under the text, full width. (Phones don't reach these, but nothing may overflow.)

**Switch** (new, `button[role=switch][aria-checked]`): 36x20, radius 10, off `--panel-2` with `--border`, on `--accent`... note: guide 3.2 says blue is the one primary next step; a switch's on state is state, not a call to action, and every system draws it in the accent colour. If Paul would rather not, on-state is `--chat-muted`-grey with white knob. Recommend accent blue (Discord/Windows/Apple all do) and ask Paul. Focus ring `--focus`. Space/Enter toggles. Click target is the whole row's switch area (36x20 plus 4 px padding), label is a `<label for>`.

**Slider:** keep `accent-color:var(--chat-muted)` and the default tick. Height 16 px.

**Disabled rows** (when a sound is off): the volume row at 45% opacity, controls disabled, still visible (guide 6.1).

### 5.1 Admin (520 px, one dialog)

Structure, top to bottom:
1. Header: "Admin" + X.
2. Error line (reserved, 16 px, red text, `min-height:16px`) so nothing moves (principle 5).
3. Group "ACCOUNTS · 3" with the add form on the same row as the heading would crowd; instead a first row:
   `[ Name ..................... ] [Add account]` (input flex 1, blue button; one blue on the surface).
4. New-password notice (`.new-pw`, `--warn` background, 8 px radius 4) directly below the add row, with Copy button (grey); reserved space not needed (appears below the control row, nothing under the pointer moves except what's below it).
5. Account rows (not a table):
   - Left: name 13 px/600 `--chat-name` + badges (owner `--owner`, admin `--admin`, banned `--danger` text on `--panel-2`); subtitle: "online" in `--ok` with a dot, or "Last seen 3 h ago" / "Never signed in" `--muted`.
   - Right: "..." icon button (24 px, always visible, tooltip "Actions for Alex"; menu opens downward, right-aligned to the button). Owner row and your own row show "You" (muted) and no menu.
   - Menu (for members): `Reset password` / separator / `Ban` (red text) or `Unban` (normal) / `Delete` (red text). Click arms ("Ban? Click again", red text, menu stays open 3 s); second click acts. Delete and Ban red text only; no red fills in rest state.
6. Group "RECENT ACTIVITY": 5 lines max visible (max-height 120, scroll), 12 px: time muted fixed 64 px, then "Paul banned Alex". Empty: "Nothing yet." (`.muted.pad`).
7. Owner only: group "ADMINS (OWNER ONLY)": rows for each admin: name+badge, trailing grey "Remove admin" button and "..." (Reset password). Last row: `[ select member ........ ] [Make admin]` with a grey Make admin button. Empty admins: "No other admins." (muted).
8. No footer; Esc and X close.

```
+----------------------------------------------------------+
| Admin                                                  X |
|                                                          |
| ACCOUNTS · 3                                             |
| [ Name ............................ ] [ Add account ]    |
| ---------------------------------------------------------|
| Alex                                               ...   |
| Never signed in                                          |
| ---------------------------------------------------------|
| Paul [owner]                                       You   |
| ● online                                                 |
| ---------------------------------------------------------|
| Steve [banned]                                     ...   |
| Last seen 3 h ago          +----------------+            |
|                            | Reset password |            |
| RECENT ACTIVITY            |----------------|            |
| 3 h ago   Paul banned Steve| Unban          |            |
| 2 d ago   Paul added Alex  | Delete (red)   |            |
|                            +----------------+            |
| ADMINS (OWNER ONLY)                                      |
| No other admins.                                         |
| [ Alex ......................v ] [ Make admin ]           |
+----------------------------------------------------------+
```

Why a menu rather than three buttons: A1-A2 (and 15 rows x 3 buttons is the problem seen in the screenshot: four equal-weight buttons make the destructive action as inviting as the routine one). If Paul prefers fewer clicks, the alternative is one visible grey "Reset password" button plus "..."; I would not keep Ban/Delete visible.

### 5.2 Voice (520 px)

```
+----------------------------------------------------------+
| Voice settings                                         X |
|                                                          |
| INPUT                                                    |
| ---------------------------------------------------------|
| Microphone                              [ Default     v ]|
| ---------------------------------------------------------|
| Mic level                    [=====o--------]    +0 dB   |
| ---------------------------------------------------------|
| Mic test                                       [ Test ]  |
| Hear yourself as others will. Use headphones.            |
| [##########------------------------------------------]   |
|                                                          |
| PROCESSING                                               |
| ---------------------------------------------------------|
| Noise filter                            [ DeepFilterNet3v]|
| DeepFilterNet3 is best; RNNoise is lighter for slow      |
| computers.                                               |
| ---------------------------------------------------------|
| Voice gate sensitivity       [=====o--------]      50%   |
| Opens only when you speak, so typing alone isn’t heard.  |
| Turn it up if your first words get cut off.              |
| ---------------------------------------------------------|
| Echo cancelling                                  [ (o) ] |
| Only on speakers. On headphones it chops up your voice.  |
+----------------------------------------------------------+
```

- Select option labels short: "DeepFilterNet3", "RNNoise", "Off" (the explanation moves to the subtitle), select width 220.
- Mic level slider: 160 px + 52 px readout "+0 dB" (nowrap).
- Mic test: the row has the title/subtitle left and a grey button "Test" right (min-width 88, text becomes "Stop test"; stays grey). The meter is a full-width 6 px bar under the row (own grid row spanning both columns, `margin-top:8px`), always present (empty when idle) so layout doesn't move.
- Gate sensitivity readout shows the percent (today it shows none).
- Echo cancelling: a switch row; the long checkbox label becomes title + subtitle.
- Height: about 7 rows x 52 + 2 headings + header = about 520 px, fits in a 657 px viewport (no scroll). The two-line subtitles add about 32 px.
- No footer; X and Esc.

### 5.3 Sound (520 px)

```
+----------------------------------------------------------+
| Sound settings                                         X |
|                                                          |
| MESSAGE SOUND                                            |
| ---------------------------------------------------------|
| Play for new messages                            [ (o) ] |
| In a chat you’re not looking at.                         |
| ---------------------------------------------------------|
| Volume                   [=======o---]    70%   [ Test ] |
|                                                          |
| VOICE CHAT SOUNDS                                        |
| ---------------------------------------------------------|
| Play for voice chat events                       [ (o) ] |
| Joining, leaving, mute and deafen.                       |
| ---------------------------------------------------------|
| Volume                   [=======o---]    70%   [ Test ] |
+----------------------------------------------------------+
```

- One group per sound (guide 8: "one section per sound"; a new sound adds a group). Group head = the sound's name; first row the switch with title + subtitle; second row Volume: slider 160 + readout 40 + grey Test (min-width 64, nowrap).
- Tick above the slider at 70% stays (existing CSS).
- Switch off: the Volume row is 45% opacity and disabled, still visible.
- Height about 340 px.

---

## 6. The single-Settings question

**Recommendation: merge Voice and Sounds into one "Settings" dialog with a short left nav (Voice, Sounds), 680 px wide, not full-screen. Keep Admin separate. Leave Minecraft Name and Change Password as the small 380 px dialogs.**

Reasons:
- Voice + Sounds is the same kind of thing (personal, per-browser, instant) and today's menu has two entries for what Discord/Slack present as one Settings with sections. The account menu shrinks from 7 to 6 items (Admin, Keyboard Shortcuts, Settings, Minecraft Name, Change Password, Log Out, Log Out Everywhere).
- Discord and Slack both do nav-in-a-window for personal settings (2.5); VS Code and GNOME use sections of one surface too. A future new sound or setting has an obvious home.
- It makes the row, group, switch and slider parts one shared component set used in one place, and ends the "three layouts" feel.
- Admin stays out: it is admin-only, wider-purpose, live-updating (`adminChanged()`), and not a personal setting; Discord also keeps Server Settings separate from User Settings.

Counter-points (honest): with two sections the nav is more chrome than content (the rule of thumb in 2.5 says a nav starts to pay at 5-6 sections), it adds a layer (principle 4), and the S49 handoff explicitly split Sound out of Voice on purpose. Opening a specific page from the menu would need "Voice Settings" / "Sound Settings" to remain as direct links into sections (menu keeps both entries, both open the Settings dialog on that section), which costs a little code.

**Cheaper alternative: keep two dialogs, 520 px, with the shared row/group/switch parts from section 5.** It fixes everything Paul called amateur, needs no nav and no menu change, and the merge can be added later by wrapping the same two bodies in a nav. If Paul wants the least work now, take this and revisit the merge when a third section (Account, Notifications ...) appears.

Either way the Admin dialog and the two small forms follow the same frame (padding 24, header with close, groups).

---

## 7. Sources

- libadwaita boxed lists: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/boxed-lists.html
- GNOME HIG boxed lists: https://developer.gnome.org/hig/patterns/containers/boxed-lists.html
- GNOME HIG dialogs: https://developer.gnome.org/hig/patterns/feedback/dialogs.html
- Windows toggle switches: https://learn.microsoft.com/en-us/windows/apps/design/controls/toggles
- Windows dialogs: https://learn.microsoft.com/en-us/windows/apps/design/controls/dialogs-and-flyouts/dialogs
- Windows app settings guidelines: https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings
- SettingsCard / SettingsExpander: https://winuicommunity.github.io/winUICommunityComponents/controls/settingsCard/ and https://github.com/CommunityToolkit/Windows/blob/main/components/SettingsControls/samples/SettingsExpander.md
- Apple HIG toggles and settings: https://developer.apple.com/design/human-interface-guidelines/toggles , https://developer.apple.com/design/human-interface-guidelines/settings (summaries only)
- Material 3 dialogs: https://m3.material.io/components/dialogs/guidelines (only width and padding came through)
- NN/g modal dialogs: https://www.nngroup.com/articles/modal-nonmodal-dialog/
- VS Code Settings editor: https://code.visualstudio.com/docs/configure/settings
- Discord voice settings (third-party): https://www.howtogeek.com/663414/how-to-configure-your-microphone-and-headset-in-discord/
- Discord moderation (third-party): https://www.groovypost.com/howto/kick-or-ban-someone-on-discord/
- GitHub removing a member: https://docs.github.com/en/organizations/managing-membership-in-your-organization/removing-a-member-from-your-organization
- Slack notifications: https://slack.com/help/articles/201355156-Configure-your-Slack-notifications
- Carbon data table: https://carbondesignsystem.com/components/data-table/usage/
- Smashing, dangerous actions: https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/
- UX Movement, destructive actions: https://uxmovement.com/buttons/how-to-design-destructive-actions-that-prevent-data-loss/

Not verified: Material list guidance (only dialogs fetched), Primer/GitHub settings pages (the fetch returned only a home page),
Slack's current Preferences layout beyond the help article, and exact current Discord UI.
