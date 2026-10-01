# To do

Found while commenting the code base (October 2026). Nothing here has been changed yet.

- [ ] **Unused CSS from the old name dialog.** `minesweeper/style.css` still has `.name-lead`, `.name-form`,
      `.field-note`, `.name-error-on` and `.pill-sm`, which nothing in `index.html` or the scripts uses.
- [ ] **Unreachable branch.** `rankedText`'s `!answer.ranked` case in `minesweeper/app.js` can't be reached from
      its only caller, `verifyWin`.
