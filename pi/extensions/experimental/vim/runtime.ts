import type { EditorHost, Change } from "@clanker-stuff/editor";
import { isKeyRelease, matchesKey, parseKey, decodeKittyPrintable } from "@earendil-works/pi-tui";
import { execute, selection, type Mode, type State } from "./core/commands.js";
import { normalCursor, exitInsert, type View } from "./core/document.js";
import { Parser, type Command } from "./core/parser.js";
import {
  Transactions,
  Insertion,
  applyDelta,
  selectionExtent,
  selectionEnd,
  type SelectionExtent,
  type Delta,
} from "./transactions.js";

interface Pending {
  before: View;
  insertion: Insertion;
  command: Command;
  selection?: SelectionExtent;
}
interface Edits {
  observed: View;
  /** An open Insert session: one transaction and one dot-repeatable change. */
  pending?: Pending;
  repeat?: { command: Command; delta?: Delta; selection?: SelectionExtent };
}

export function mountVim(host: EditorHost, publish: (mode: Mode) => void): () => void {
  let release: (() => void) | undefined;
  let dispose: (() => void) | undefined;
  const unmount = host.onMount((editor) => {
    const parser = new Parser();
    const history = new Transactions();
    const view = editor.document.view;
    let state: State = { mode: "insert", anchor: 0, register: { text: "", linewise: false } };
    let edits: Edits = { observed: view() };
    let suspended = false;
    let historyNavigation = false;
    let observedHistory = editor.document.historyIndex();
    const mode = (next: Mode) => {
      state.mode = next;
      parser.reset();
      publish(next);
      editor.refresh();
    };
    const reset = () => {
      history.clear();
      edits = { observed: view() };
      observedHistory = editor.document.historyIndex();
      mode("insert");
    };
    const insertDelta = (delta: Delta) => {
      const edit = applyDelta(view(), delta);
      const encoded = editor.document.encode(edit.text);
      editor.edit(edit.start, edit.end, encoded, edit.start + encoded.length);
    };
    const finish = () => {
      const pending = edits.pending;
      if (pending) {
        let { command } = pending;
        let delta = pending.insertion.delta(view());
        if (
          "iIaAoO".includes(command.key) &&
          command.count > 1 &&
          delta.text.length * command.count <= 1_000_000
        ) {
          for (let n = 1; n < command.count; n++) {
            const before = view();
            if (command.key === "o" || command.key === "O") run({ ...command, count: 1 }, true);
            insertDelta(delta);
            pending.insertion.record(before, view());
          }
          delta = pending.insertion.delta(view());
          command = { ...command, count: 1 };
        }
        if (delta.remove || delta.text || pending.before.text !== editor.document.text())
          edits.repeat = { command, delta, selection: pending.selection };
        history.commit(pending.before, view());
      }
      edits.pending = undefined;
      editor.document.clearNativeUndo();
      edits.observed = view();
    };
    const run = (command: Command, replay = false) => {
      const before = view();
      const oldMode = state.mode;
      const extent = oldMode.startsWith("visual")
        ? selectionExtent(view(), selection(view(), state), oldMode === "visual-line")
        : undefined;
      const result = execute(view(), state, command);
      if (!result) return;
      if (result.yank) {
        let text = editor.document.expand(
          editor.document.text().slice(result.yank.start, result.yank.end),
        );
        if (result.yank.linewise && !text.endsWith("\n")) text += "\n";
        state.register = { text, linewise: result.yank.linewise };
      }
      if (result.edit) {
        const { start, end, text, foreign } = result.edit;
        const encoded = foreign ? editor.document.encode(text) : text;
        editor.edit(start, end, encoded, encoded === text ? result.cursor : start);
      } else editor.document.move(result.cursor);
      if (result.anchor !== undefined) state.anchor = result.anchor;
      if (result.mode) {
        if (result.mode.startsWith("visual") && !oldMode.startsWith("visual"))
          state.anchor = result.cursor;
        mode(result.mode);
      }
      if (state.mode === "insert" && !replay)
        edits.pending = { before, insertion: new Insertion(view()), command, selection: extent };
      else if (result.edit && !replay) {
        history.commit(before, view());
        edits.repeat = { command, selection: extent };
      }
      if (state.mode !== "insert")
        editor.document.move(normalCursor(view(), editor.document.cursor()));
      edits.observed = view();
      editor.refresh();
    };
    const undo = (redo: boolean, stay = false) => {
      finish();
      const draft = redo ? history.redo(view()) : history.undo(view());
      if (draft) editor.restoreView(draft);
      mode(stay ? "insert" : "normal");
      edits.observed = view();
    };
    const dot = (count: number, explicit: boolean) => {
      const saved = edits.repeat;
      if (!saved) return;
      const before = view();
      const insert = "iIaAoO".includes(saved.command.key);
      const command = explicit && !insert ? { ...saved.command, count } : saved.command;
      for (let n = 0; n < (insert ? count : 1); n++) {
        if (saved.selection) {
          state.anchor = editor.document.cursor();
          state.mode = saved.selection.linewise ? "visual-line" : "visual";
          editor.document.move(selectionEnd(view(), saved.selection));
        }
        run(command, true);
        if (saved.delta) insertDelta(saved.delta);
        if (state.mode === "insert") editor.document.move(exitInsert(view()));
        mode("normal");
      }
      history.commit(before, view());
      edits.observed = view();
      editor.refresh();
    };
    // The host reports only changes made outside this engine.
    const changed = (kind: Change, before = edits.observed) => {
      const recalled =
        kind === "input" && historyNavigation && editor.document.historyIndex() !== observedHistory;
      if (recalled || kind === "replace" || suspended) {
        suspended = false;
        reset();
        return;
      }
      if (state.mode === "insert") {
        edits.pending ??= {
          before,
          insertion: new Insertion(before),
          command: { key: "i", count: 1, explicit: false },
        };
        edits.pending.insertion.record(before, view());
      } else {
        history.commit(before, view());
        edits.repeat = undefined;
        parser.reset();
        editor.document.move(normalCursor(view(), editor.document.cursor()));
      }
      edits.observed = view();
    };
    const inserting = () => state.mode === "insert";
    const input = (data: string): boolean => {
      if (isKeyRelease(data)) return true;
      const bindings = editor.keys;
      observedHistory = editor.document.historyIndex();
      historyNavigation =
        bindings.matches(data, "tui.editor.historyPrevious") ||
        bindings.matches(data, "tui.editor.historyNext") ||
        bindings.matches(data, "tui.editor.cursorUp") ||
        bindings.matches(data, "tui.editor.cursorDown");
      if (suspended) return false;
      if (bindings.matches(data, "tui.editor.undo")) {
        // A key Pi users already know keeps typing; only Vim's own `u` implies Normal.
        undo(false, state.mode === "insert");
        return true;
      }
      if (state.mode !== "insert" && matchesKey(data, "ctrl+r")) {
        undo(true);
        return true;
      }
      if (matchesKey(data, "escape")) {
        parser.reset();
        if (editor.isShowingAutocomplete()) {
          editor.nativeInput(data);
          return true;
        }
        if (state.mode === "insert") {
          finish();
          editor.document.move(exitInsert(view()));
          mode("normal");
          return true;
        }
        if (state.mode !== "normal") {
          mode("normal");
          return true;
        }
        return false;
      }
      if (state.mode === "insert") {
        edits.observed = view();
        return false;
      }
      if (
        bindings.matches(data, "tui.input.submit") ||
        bindings.matches(data, "tui.input.newLine") ||
        editor.keys.matches(data, "app.clipboard.pasteImage") ||
        [...editor.actionHandlers.keys()].some((action) => editor.keys.matches(data, action))
      ) {
        parser.reset();
        edits.observed = view();
        return false;
      }
      const key = parseKey(data);
      if (
        key &&
        (key.includes("ctrl+") ||
          key.includes("alt+") ||
          ["enter", "shift+enter", "tab", "up", "down", "left", "right"].includes(key))
      ) {
        parser.reset();
        edits.observed = view();
        return false;
      }
      const shifted = key?.startsWith("shift+") ? key.slice(6) : undefined;
      const printable =
        decodeKittyPrintable(data) ??
        (shifted && [...segmenter.segment(shifted)].length === 1
          ? shifted.toUpperCase()
          : key === "space"
            ? " "
            : key && [...segmenter.segment(key)].length === 1
              ? key
              : data);
      if (/[\p{Cc}]/u.test(printable)) {
        parser.reset();
        return false;
      }
      for (const { segment } of segmenter.segment(printable)) {
        // A preceding command in this packet may have entered Insert.
        if (inserting()) {
          editor.nativeInput(segment);
          continue;
        }
        const command = parser.feed(segment, state.mode.startsWith("visual"));
        if (!command) continue;
        if (command.key === "u") {
          for (let n = 0; n < command.count; n++) undo(false);
        } else if (command.key === ".") dot(command.count, command.explicit);
        else run(command);
      }
      return true;
    };
    release = host.contribute("editing", {
      input,
      changed,
      submitted: reset,
      suspend: () => {
        const saved = { state: { ...state }, edits: { ...edits } };
        suspended = true;
        parser.reset();
        return (restore: boolean) => {
          suspended = false;
          if (!restore) {
            reset();
            return;
          }
          state = saved.state;
          edits = saved.edits;
          mode(state.mode);
        };
      },
      selection: () => {
        if (!state.mode.startsWith("visual")) return [];
        const range = selection(view(), state);
        return [{ ...range, end: Math.max(range.end, range.start + 1), selected: true }];
      },
    });
    dispose = () => {
      parser.reset();
      editor.document.cancelCompletion();
    };
    publish("insert");
  });
  return () => {
    unmount();
    dispose?.();
    release?.();
  };
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
