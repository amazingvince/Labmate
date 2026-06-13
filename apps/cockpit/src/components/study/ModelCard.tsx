/** Renders the generated model-card markdown as a styled document. No typography
 *  plugin — element styles are mapped explicitly so it sits in the shadcn theme
 *  (and renders the GFM experiments table the card emits). */
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  h1: ({ node: _n, ...p }) => <h1 className="mb-1 text-xl font-semibold tracking-tight" {...p} />,
  h2: ({ node: _n, ...p }) => (
    <h2
      className="mt-6 mb-2 border-b pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      {...p}
    />
  ),
  h3: ({ node: _n, ...p }) => <h3 className="mt-4 mb-1 text-sm font-semibold" {...p} />,
  p: ({ node: _n, ...p }) => <p className="my-2 leading-relaxed" {...p} />,
  ul: ({ node: _n, ...p }) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  li: ({ node: _n, ...p }) => <li className="marker:text-muted-foreground" {...p} />,
  strong: ({ node: _n, ...p }) => <strong className="font-medium text-foreground" {...p} />,
  a: ({ node: _n, ...p }) => (
    <a className="text-brand underline-offset-2 hover:underline" target="_blank" rel="noreferrer" {...p} />
  ),
  hr: ({ node: _n, ...p }) => <hr className="my-5 border-border" {...p} />,
  blockquote: ({ node: _n, ...p }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...p} />
  ),
  pre: ({ node: _n, ...p }) => (
    <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed" {...p} />
  ),
  code: ({ node: _n, className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? '')
    return isBlock ? (
      <code className="font-mono" {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props}>
        {children}
      </code>
    )
  },
  table: ({ node: _n, ...p }) => (
    <div className="my-3 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs" {...p} />
    </div>
  ),
  thead: ({ node: _n, ...p }) => <thead className="bg-muted/50" {...p} />,
  th: ({ node: _n, ...p }) => (
    <th className="border-b px-2.5 py-1.5 text-left font-medium text-muted-foreground" {...p} />
  ),
  td: ({ node: _n, ...p }) => <td className="border-b px-2.5 py-1.5 align-top" {...p} />,
}

export function ModelCard({ markdown }: { markdown: string }) {
  return (
    <div className="text-sm text-foreground/90">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
