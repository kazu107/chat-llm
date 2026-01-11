// components/Markdown.tsx
"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

async function copyPlain(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            return true;
        } catch {
            return false;
        }
    }
}

function extractText(node: React.ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(extractText).join("");
    if (React.isValidElement(node)) {
        const el = node as React.ReactElement<any, any>;
        const children: React.ReactNode = (el.props as { children?: React.ReactNode }).children;
        return extractText(children ?? "");
    }
    return "";
}

export type MarkdownViewProps = {
    /** AppShellなどで <Markdown text="..."/> で渡した場合 */
    text?: string;
    /** <Markdown>...</Markdown> で渡した場合 */
    children?: React.ReactNode;
};

export default function Markdown(props: MarkdownViewProps) {
    const content =
        typeof props.text === "string"
            ? props.text
            : typeof props.children === "string"
                ? props.children
                : props.children == null
                    ? ""
                    : String(props.children);

    return (
        <div className="md">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    code({ className, children, ...rest }) {
                        const isBlock = Boolean(className && /^language-/.test(className));
                        const raw = extractText(children);
                        const lang = (className ?? "").replace("language-", "") || "code";

                        if (isBlock) {
                            return (
                                <div className="codeBlock">
                                    <div className="codeBlockHeader">
                                        <span className="codeLang">{lang}</span>
                                        <button
                                            type="button"
                                            className="codeCopy"
                                            onClick={() => copyPlain(raw)}
                                        >
                                            Copy
                                        </button>
                                    </div>
                                    <pre className={`codePre ${className ?? ""}`}>
                                        <code className={className} {...rest}>
                                            {children}
                                        </code>
                                    </pre>
                                </div>
                            );
                        }

                        return (
                            <code className={className} {...rest}>
                                {children}
                            </code>
                        );
                    },
                    pre({ children }) {
                        // code側でpreを描画するため、ここでは素通し
                        return <>{children}</>;
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
