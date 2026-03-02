"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Components } from "react-markdown";

export default function MarkdownContent({ content }: { content: string }) {
  const components: Components = {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const codeString = String(children).replace(/\n$/, "");

      if (match) {
        return (
          <SyntaxHighlighter
            style={oneDark}
            language={match[1]}
            PreTag="div"
            customStyle={{
              margin: "0.5rem 0",
              borderRadius: "0.5rem",
              fontSize: "0.75rem",
            }}
          >
            {codeString}
          </SyntaxHighlighter>
        );
      }

      return (
        <code
          className="bg-neutral-100 dark:bg-neutral-900 rounded px-1.5 py-0.5 text-xs font-mono"
          {...props}
        >
          {children}
        </code>
      );
    },
    h1({ children }) {
      return <h1 className="text-xl font-bold mt-4 mb-2 text-neutral-100">{children}</h1>;
    },
    h2({ children }) {
      return <h2 className="text-lg font-bold mt-3 mb-2 text-neutral-100">{children}</h2>;
    },
    h3({ children }) {
      return <h3 className="text-base font-semibold mt-2 mb-1 text-neutral-200">{children}</h3>;
    },
    ul({ children }) {
      return <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>;
    },
    li({ children }) {
      return <li className="text-sm">{children}</li>;
    },
    blockquote({ children }) {
      return (
        <blockquote className="border-l-2 border-amber-500 pl-3 my-2 text-neutral-400 italic">
          {children}
        </blockquote>
      );
    },
    table({ children }) {
      return (
        <div className="overflow-x-auto my-2">
          <table className="min-w-full text-xs border-collapse border border-neutral-700">
            {children}
          </table>
        </div>
      );
    },
    thead({ children }) {
      return <thead className="bg-neutral-800">{children}</thead>;
    },
    th({ children }) {
      return (
        <th className="border border-neutral-700 px-2 py-1 text-left font-semibold text-neutral-200">
          {children}
        </th>
      );
    },
    td({ children }) {
      return (
        <td className="border border-neutral-700 px-2 py-1 text-neutral-300">{children}</td>
      );
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-amber-500 hover:text-amber-400 underline break-all"
        >
          {children}
        </a>
      );
    },
    p({ children }) {
      return <p className="my-1">{children}</p>;
    },
    strong({ children }) {
      return <strong className="font-semibold">{children}</strong>;
    },
  };

  return (
    <div className="prose prose-invert prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
