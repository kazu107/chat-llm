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

function detectLang(className: string | undefined) {
    if (!className) return "code";
    const match = className
        .split(/\s+/)
        .find((token) => token.startsWith("language-"));
    const lang = match ? match.replace("language-", "") : "";
    return lang || "code";
}

export type MarkdownViewProps = {
    /** AppShellなどで <Markdown text="..."/> で渡した場合 */
    text?: string;
    /** <Markdown>...</Markdown> で渡した場合 */
    children?: React.ReactNode;
    showCodeCopy?: boolean;
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
    const showCodeCopy = props.showCodeCopy !== false;

    return (
        <div className="md">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                    code({ className, children, node: _node, inline: _inline, ...rest }: any) {
                        return (
                            <code className={className} {...rest}>
                                {children}
                            </code>
                        );
                    },
                    pre({ children, className, node: _node, ...rest }: any) {
                        const nodes = React.Children.toArray(children);
                        const codeElement = nodes.find((child) => React.isValidElement(child)) as
                            | React.ReactElement<{ className?: string; children?: React.ReactNode }>
                            | undefined;
                        const codeClassName =
                            codeElement && typeof codeElement.props.className === "string"
                                ? codeElement.props.className
                                : "";
                        const raw = codeElement ? extractText(codeElement.props.children) : extractText(children);
                        const lang = detectLang(codeClassName);

                        if (!codeElement) {
                            return (
                                <pre className={className} {...rest}>
                                    {children}
                                </pre>
                            );
                        }

                        return (
                            <div
                                className="codeBlock"
                                style={{
                                    margin: "10px 0",
                                    border: "1px solid rgba(255,255,255,0.22)",
                                    borderRadius: 12,
                                    overflow: "hidden",
                                    background: "linear-gradient(180deg, #0f1117 0%, #0b0d12 100%)",
                                    boxShadow: "0 10px 32px rgba(0,0,0,0.35)",
                                }}
                            >
                                <div
                                    className="codeBlockHeader"
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        padding: "8px 12px",
                                        borderBottom: "1px solid rgba(255,255,255,0.12)",
                                        color: "rgba(167,173,189,0.95)",
                                        fontSize: 12,
                                        letterSpacing: "0.02em",
                                        textTransform: "uppercase",
                                        background: "rgba(255,255,255,0.03)",
                                    }}
                                >
                                    <span className="codeLang" style={{ fontWeight: 700 }}>{lang}</span>
                                    {showCodeCopy && (
                                        <button
                                            type="button"
                                            className="codeCopy"
                                            onClick={() => copyPlain(raw)}
                                            title="Copy code"
                                            aria-label="Copy code block"
                                            style={{
                                                border: "1px solid rgba(255,255,255,0.16)",
                                                background: "rgba(255,255,255,0.06)",
                                                color: "rgba(230,232,239,0.95)",
                                                borderRadius: 10,
                                                padding: "4px 10px",
                                                fontSize: 12,
                                                cursor: "pointer",
                                                lineHeight: 1.2,
                                            }}
                                        >
                                            Copy
                                        </button>
                                    )}
                                </div>
                                <pre
                                    className={["codePre", className].filter(Boolean).join(" ")}
                                    style={{
                                        margin: 0,
                                        padding: 12,
                                        overflow: "auto",
                                        background: "transparent",
                                    }}
                                    {...rest}
                                >
                                    {React.cloneElement(codeElement, { className: codeClassName })}
                                </pre>
                            </div>
                        );
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
