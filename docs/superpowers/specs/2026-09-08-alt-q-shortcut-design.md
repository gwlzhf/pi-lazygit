# Alt+Q Shortcut Design

## Goal

Replace the files review panel shortcut `Ctrl+Shift+G` with `Alt+Q`.

## Scope

- Change `FILES_SHORTCUT` in `src/index.ts` from `ctrl+shift+g` to `alt+q`.
- Keep `/files` unchanged.
- Do not retain or register the old shortcut.
- Update the registration test name and assertion in `src/index.test.ts`.
- Update the documented shortcut in `README.md`.

## Behavior

In an interactive OMP TUI session, pressing `Alt+Q` opens the same files review panel as `/files`. Existing panel availability, duplicate-open prevention, and error handling remain unchanged.

## Verification

Run the focused shortcut registration test, then the full project test suite. Confirm that the registered shortcut is exactly `alt+q` and that the command and shortcut still share the same panel opener.
