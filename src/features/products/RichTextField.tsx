import { useEffect, useId, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Check, CodeXml, Heading2, Heading3, Italic, Link, List, ListOrdered, Redo2, Underline, Undo2, Unlink } from 'lucide-react'
import { isLosslessForEditor, withParagraphs } from './richText'

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`icon-button rich-text-button${active ? ' active' : ''}`} aria-label={label} title={label} aria-pressed={active} disabled={disabled}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>
}

export function RichTextField({ label, value, onChange, disabled = false, compact = false }: {
  label: string; value: string; onChange: (html: string) => void; disabled?: boolean; compact?: boolean
}) {
  const labelId = useId()
  const [mode, setMode] = useState<'visual' | 'html'>(() => (isLosslessForEditor(value) ? 'visual' : 'html'))
  const [lossy, setLossy] = useState(() => !isLosslessForEditor(value))
  const [linkDraft, setLinkDraft] = useState<string | null>(null)

  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [2, 3, 4] }, code: false, codeBlock: false,
      // Keep links as entered: no forced new tab or nofollow on shop-internal links.
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { target: null, rel: null } },
    })],
    content: withParagraphs(value),
    editable: !disabled,
    editorProps: { attributes: { class: 'rich-text-content', role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': labelId } },
    // Fires only for user edits, never for loading the text: unchanged descriptions are not sent to the shop.
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
  })

  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'),
      h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
      bulletList: editor.isActive('bulletList'), orderedList: editor.isActive('orderedList'), link: editor.isActive('link'),
      canUndo: editor.can().undo(), canRedo: editor.can().redo(),
    }),
  })

  useEffect(() => { editor.setEditable(!disabled) }, [editor, disabled])

  function switchMode() {
    if (mode === 'html') {
      // Edits made in the HTML view are loaded into the editor without counting as a change.
      editor.commands.setContent(withParagraphs(value), { emitUpdate: false })
      setLossy(!isLosslessForEditor(value))
    }
    setLinkDraft(null)
    setMode(mode === 'html' ? 'visual' : 'html')
  }

  function applyLink() {
    const href = linkDraft?.trim() ?? ''
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run()
    setLinkDraft(null)
  }

  const visual = mode === 'visual'
  return <div className={`auth-field rich-text${compact ? ' compact' : ''}`}>
    <span id={labelId}>{label}</span>
    <div className="rich-text-frame">
      <div className="rich-text-toolbar" role="toolbar" aria-label={`${label} formatieren`}>
        {visual && <>
          <ToolButton label="Fett" active={state.bold} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></ToolButton>
          <ToolButton label="Kursiv" active={state.italic} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></ToolButton>
          <ToolButton label="Unterstrichen" active={state.underline} disabled={disabled} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={15} /></ToolButton>
          <span className="rich-text-divider" />
          <ToolButton label="Ueberschrift" active={state.h2} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></ToolButton>
          <ToolButton label="Zwischenueberschrift" active={state.h3} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></ToolButton>
          <ToolButton label="Aufzaehlung" active={state.bulletList} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></ToolButton>
          <ToolButton label="Nummerierte Liste" active={state.orderedList} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></ToolButton>
          <span className="rich-text-divider" />
          <ToolButton label="Link" active={state.link || linkDraft !== null} disabled={disabled} onClick={() => setLinkDraft(linkDraft === null ? editor.getAttributes('link').href ?? '' : null)}><Link size={15} /></ToolButton>
          {state.link && <ToolButton label="Link entfernen" disabled={disabled} onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}><Unlink size={15} /></ToolButton>}
          <span className="rich-text-divider" />
          <ToolButton label="Rueckgaengig" disabled={disabled || !state.canUndo} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></ToolButton>
          <ToolButton label="Wiederholen" disabled={disabled || !state.canRedo} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></ToolButton>
        </>}
        <button type="button" className={`rich-text-mode${visual ? '' : ' active'}`} aria-pressed={!visual} disabled={disabled} onClick={switchMode}><CodeXml size={14} />HTML</button>
      </div>
      {visual && linkDraft !== null && <div className="rich-text-link">
        <input autoFocus type="url" aria-label="Link-Adresse" placeholder="https://… (leer = Link entfernen)" value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter must not submit the product form.
            if (event.key === 'Enter') { event.preventDefault(); applyLink() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLinkDraft(null) }
          }} />
        <button type="button" className="button" onClick={applyLink}><Check size={14} />Uebernehmen</button>
      </div>}
      {visual
        ? <EditorContent editor={editor} />
        : <textarea className="rich-text-source" aria-labelledby={labelId} spellCheck={false} rows={compact ? 4 : 10} value={value} onChange={(event) => onChange(event.target.value)} />}
    </div>
    {lossy && <p className="taxonomy-hint">{visual
      ? 'Achtung: Formatierungen, die der Editor nicht darstellen kann, gehen verloren, sobald du hier etwas aenderst.'
      : 'Dieser Text enthaelt Formatierungen, die der Editor nicht darstellen kann (z. B. Stile, Tabellen oder Block-Kommentare). Beim Bearbeiten im Editor gingen sie verloren, deshalb ist die HTML-Ansicht geoeffnet.'}</p>}
  </div>
}
