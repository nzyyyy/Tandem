import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { allowsExternal } from "../../shared/conversation.ts";
import { Button } from "./ui.tsx";

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => (allowsExternal(url) ? url : "")}
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) =>
            href && allowsExternal(href) ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  void window.tandem.openExternal(href);
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <div className="code-block">
      <div className="row code-toolbar">
        <span>代码</span>
        <span className="spacer" />
        <Button
          kind="plain"
          onClick={(event) => {
            const text =
              event.currentTarget.closest(".code-block")?.querySelector("code")
                ?.textContent ?? "";
            void window.tandem.copy(text.replace(/\n$/, ""));
          }}
        >
          复制代码
        </Button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
