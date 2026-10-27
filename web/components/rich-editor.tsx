"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import {
  LexicalComposer,
  type InitialConfigType,
} from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $createHeadingNode,
  $isHeadingNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import {
  $insertList,
  $isListNode,
  $removeList,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { $findMatchingParent, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type EditorThemeClasses,
  type LexicalEditor,
} from "lexical";
import {
  lexicalToMarkdown,
  markdownToLexical,
  NOTE_TRANSFORMERS,
} from "@/lib/note-markdown";

/**
 * Which formats are active at the caret, plus undo/redo availability. The
 * toolbar reads this so a button lights up while the caret sits inside bold
 * text, exactly like the mobile editor.
 */
export type EditorFormatting = {
  bold: boolean;
  italic: boolean;
  code: boolean;
  heading: boolean;
  bullet: boolean;
  numbered: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export const EMPTY_FORMATTING: EditorFormatting = {
  bold: false,
  italic: false,
  code: false,
  heading: false,
  bullet: false,
  numbered: false,
  canUndo: false,
  canRedo: false,
};

export type RichEditorHandle = {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleCode: () => void;
  toggleHeading: () => void;
  toggleBulletList: () => void;
  toggleNumberedList: () => void;
  undo: () => void;
  redo: () => void;
};

const THEME: EditorThemeClasses = {
  paragraph: "editor-p",
  heading: {
    h1: "editor-h1",
    h2: "editor-h2",
    h3: "editor-h3",
    h4: "editor-h4",
    h5: "editor-h4",
    h6: "editor-h4",
  },
  quote: "editor-quote",
  list: {
    ul: "editor-ul",
    ol: "editor-ol",
    listitem: "editor-li",
    nested: { listitem: "editor-li" },
  },
  text: { code: "editor-code" },
};

/** Swap a block between `## ` heading and plain paragraph. */
function toggleHeading(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const heading = $findMatchingParent(selection.anchor.getNode(), $isHeadingNode);
    $setBlocksType(selection, () => (heading ? $createParagraphNode() : $createHeadingNode("h2")));
  });
}

/** `$insertList` only converts, so turning a list off needs an explicit remove. */
function toggleList(editor: LexicalEditor, listType: "bullet" | "number"): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const list = $findMatchingParent(selection.anchor.getNode(), $isListNode);
    if (list !== null && list.getListType() === listType) {
      $removeList();
      return;
    }
    $insertList(listType);
  });
}

function readFormatting(
  editor: LexicalEditor,
  canUndo: boolean,
  canRedo: boolean,
): EditorFormatting {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    const range = $isRangeSelection(selection) ? selection : null;
    const anchor = range ? range.anchor.getNode() : null;
    const list = anchor ? $findMatchingParent(anchor, $isListNode) : null;
    const heading = anchor ? $findMatchingParent(anchor, $isHeadingNode) : null;
    return {
      bold: range !== null && range.hasFormat("bold"),
      italic: range !== null && range.hasFormat("italic"),
      code: range !== null && range.hasFormat("code"),
      heading: heading !== null,
      bullet: list !== null && list.getListType() === "bullet",
      numbered: list !== null && list.getListType() === "number",
      canUndo,
      canRedo,
    };
  });
}

/**
 * Bridge between the Lexical context and the surrounding form: publishes
 * markdown on every change, mirrors the active formats, and exposes the
 * toolbar commands through the forwarded ref.
 */
const EditorBridge = forwardRef<
  RichEditorHandle,
  {
    onChange: (markdown: string) => void;
    onFormattingChange?: (formatting: EditorFormatting) => void;
  }
>(function EditorBridge({ onChange, onFormattingChange }, ref) {
  const [editor] = useLexicalComposerContext();
  const handlers = useRef({ onChange, onFormattingChange });
  const canUndo = useRef(false);
  const canRedo = useRef(false);

  useEffect(() => {
    handlers.current = { onChange, onFormattingChange };
  });

  const publish = useCallback(() => {
    handlers.current.onFormattingChange?.(
      readFormatting(editor, canUndo.current, canRedo.current),
    );
  }, [editor]);

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          CAN_UNDO_COMMAND,
          (payload: boolean) => {
            canUndo.current = payload;
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          CAN_REDO_COMMAND,
          (payload: boolean) => {
            canRedo.current = payload;
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerUpdateListener(() => publish()),
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          () => {
            publish();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor, publish],
  );

  useImperativeHandle(
    ref,
    () => ({
      toggleBold: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold"),
      toggleItalic: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic"),
      toggleCode: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code"),
      toggleHeading: () => toggleHeading(editor),
      toggleBulletList: () => toggleList(editor, "bullet"),
      toggleNumberedList: () => toggleList(editor, "number"),
      undo: () => editor.dispatchCommand(UNDO_COMMAND, undefined),
      redo: () => editor.dispatchCommand(REDO_COMMAND, undefined),
    }),
    [editor],
  );

  return (
    <OnChangePlugin
      onChange={(editorState) => {
        handlers.current.onChange(editorState.read(() => lexicalToMarkdown()));
      }}
    />
  );
});

export const RichEditor = forwardRef<
  RichEditorHandle,
  {
    /** Markdown the editor starts from. Read once — remount (key) to reload. */
    initialMarkdown: string;
    onChange: (markdown: string) => void;
    onFormattingChange?: (formatting: EditorFormatting) => void;
    placeholder?: string;
    ariaLabel: string;
  }
>(function RichEditor(
  { initialMarkdown, onChange, onFormattingChange, placeholder, ariaLabel },
  ref,
) {
  const initialMarkdownRef = useRef(initialMarkdown);

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "sua-note-editor",
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
      theme: THEME,
      editorState: () => {
        const root = $getRoot();
        root.clear();
        markdownToLexical(initialMarkdownRef.current);
        // Lexical expects the root to hold at least one block.
        if (root.isEmpty()) root.append($createParagraphNode());
      },
      onError(error) {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="editor-body-wrap">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="editor-surface"
              aria-label={ariaLabel}
              spellCheck
            />
          }
          placeholder={<p className="editor-placeholder">{placeholder}</p>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={NOTE_TRANSFORMERS} />
      <EditorBridge
        ref={ref}
        onChange={onChange}
        onFormattingChange={onFormattingChange}
      />
    </LexicalComposer>
  );
});
