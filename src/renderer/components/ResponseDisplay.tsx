import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ThinkingBar } from "./ThinkingBar";

interface ResponseDisplayProps {
  thoughts: string[];
  content: string;
}

export function ResponseDisplay({ thoughts, content }: ResponseDisplayProps) {
  const [displayedContent, setDisplayedContent] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Skip typewriter for long content, show immediately
  useEffect(() => {
    if (content.length > 500) {
      setDisplayedContent(content);
      setIsTyping(false);
      return;
    }

    setDisplayedContent("");
    setIsTyping(true);

    let index = 0;
    const interval = setInterval(() => {
      if (index < content.length) {
        setDisplayedContent(content.slice(0, index + 1));
        index++;
      } else {
        setIsTyping(false);
        clearInterval(interval);
      }
    }, 8);

    return () => clearInterval(interval);
  }, [content]);

  // Auto-scroll disabled - user can manually scroll

  return (
    <div className="flex flex-col gap-2.5">
      {/* Thoughts shown in ThinkingBar style */}
      {thoughts.length > 0 && (
        <ThinkingBar thoughts={thoughts} isActive={false} />
      )}

      {/* Content */}
      {content && (
        <div
          ref={scrollRef}
          className="
            text-[14px]
            text-white
            markdown-content
          "
          style={{
            maxHeight: "350px",
            overflowY: "auto",
            overflowX: "hidden",
            wordWrap: "break-word",
            pointerEvents: "auto",
            lineHeight: "1.45",
            paddingRight: "8px",
            paddingBottom: "8px",
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255, 255, 255, 0.2) transparent",
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              a: ({ node, ...props }) => (
                <a
                  {...props}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/60 hover:text-white/80 underline"
                />
              ),
              p: ({ node, ...props }) => (
                <p {...props} className="mb-1.5 last:mb-0" />
              ),
              ul: ({ node, ...props }) => (
                <ul
                  {...props}
                  className="list-disc pl-4 mb-3 space-y-0.5"
                  style={{ lineHeight: "1.3" }}
                />
              ),
              ol: ({ node, ...props }) => (
                <ol
                  {...props}
                  className="list-decimal pl-4 mb-3 space-y-0.5"
                  style={{ lineHeight: "1.3" }}
                />
              ),
              li: ({ node, ...props }) => <li {...props} className="mb-0" />,
              code: ({ node, inline, className, children, ...props }: any) =>
                inline ? (
                  <code
                    className="bg-white/10 px-1 py-0.5 rounded text-[13px]"
                    {...props}
                  >
                    {children}
                  </code>
                ) : (
                  <pre className="bg-white/5 p-3 rounded-lg my-2 overflow-x-auto">
                    <code className="text-[13px]" {...props}>
                      {children}
                    </code>
                  </pre>
                ),
            }}
          >
            {displayedContent}
          </ReactMarkdown>

          {/* Cursor while typing */}
          {isTyping && (
            <span className="inline-block w-0.5 h-4 bg-white/30 animate-pulse ml-0.5" />
          )}
        </div>
      )}
    </div>
  );
}
