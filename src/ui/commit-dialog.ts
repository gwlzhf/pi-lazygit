import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { fitCell, sanitizeTerminalText } from "./render";

export interface CommitDialogState {
  readonly title: string;
  readonly lines: readonly string[];
  readonly input?: string;
  readonly inputCursor?: number;
  readonly inputLabel?: string;
  readonly busy?: boolean;
  readonly footer?: string;
}
/** Render a width-bounded confirmation dialog with safe terminal text. */

export function renderCommitDialog(state: CommitDialogState, width: number, theme: Theme): readonly string[] {
  const rows = [
    state.title,
    ...state.lines.flatMap(line => sanitizeTerminalText(line).split("\n")),
  ];
  if (state.input !== undefined) {
    const characters = [...state.input];
    const cursor = Math.max(0, Math.min(characters.length, state.inputCursor ?? characters.length));
    rows.push(`${state.inputLabel ?? "Message"}: ${characters.slice(0, cursor).join("")}_${characters.slice(cursor).join("")}`);
  }
  if (state.busy) rows.push("Working…");
  rows.push(state.footer ?? (state.input !== undefined ? "Enter confirm · Esc cancel · Ctrl+N no-verify" : "y continue · n/Esc cancel"));
  return rows.map((row, index) => {
    const color: ThemeColor = index === 0 ? "accent" : /warning|detached|remote has new|cannot|error/i.test(row) ? "error" : "text";
    return theme.fg(color, fitCell(sanitizeTerminalText(row).replaceAll("\n", " "), width));
  });
}
