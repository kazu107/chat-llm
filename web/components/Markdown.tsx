// components/Markdown.tsx
"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownViewProps = {
    /** AppShell などで <Markdown text="..."/> で渡したい場合 */
    text?: string;
    /** <Markdown>...</Markdown> で渡したい場合 */
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
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                // react-markdown v10 では inline prop が無いので、className で判定する
                code({ className, children, ...rest }) {
                    const raw = String(children ?? "");
                    const match = /language-([\w-]+)/.exec(className ?? "");

                    // ブロックコード（```lang）
                    if (match) {
                        return (
                            <pre
                                style={{
                                    margin: "12px 0",
                                    padding: 12,
                                    borderRadius: 12,
                                    overflowX: "auto",
                                    background: "rgba(255,255,255,0.06)",
                                    border: "1px solid rgba(255,255,255,0.10)",
                                }}
                            >
                <code className={className} {...rest}>
                  {raw.replace(/\n$/, "")}
                </code>
              </pre>
                        );
                    }

                    // インラインコード（`code`）
                    return (
                        <code
                            style={{
                                padding: "2px 6px",
                                borderRadius: 8,
                                background: "rgba(255,255,255,0.08)",
                                border: "1px solid rgba(255,255,255,0.10)",
                            }}
                            className={className}
                            {...rest}
                        >
                            {raw}
                        </code>
                    );
                },
                pre({ children }) {
                    // code側でpreを描画しているので、二重にならないよう素通し
                    return <>{children}</>;
                },
            }}
        >
            {content}
        </ReactMarkdown>
    );
}
