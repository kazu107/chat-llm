"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "system" | "user" | "assistant";
type ChatMessage = { role: Role; content: string };

function nowId() {
    return Math.random().toString(16).slice(2);
}

export default function Chat() {
    const [messages, setMessages] = useState<ChatMessage[]>([
        { role: "system", content: "あなたは日本語で簡潔かつ正確に答えるアシスタントです。" }
    ]);
    const [input, setInput] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);

    const [temperature, setTemperature] = useState<number>(0.3);
    const [maxTokens, setMaxTokens] = useState<number>(512);

    const scrollRef = useRef<HTMLDivElement | null>(null);

    const canSend = useMemo(() => !busy && input.trim().length > 0, [busy, input]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, busy]);

    async function send() {
        if (!canSend) return;

        const userText = input.trim();
        setInput("");

        const nextMessages: ChatMessage[] = [...messages, { role: "user", content: userText }];
        setMessages(nextMessages);

        // 受け皿（ストリーミングで追記）
        const assistantIndex = nextMessages.length;
        setMessages([...nextMessages, { role: "assistant", content: "" }]);

        setBusy(true);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: nowId(),
                    stream: true,
                    temperature,
                    max_tokens: maxTokens,
                    messages: nextMessages
                })
            });

            if (!res.ok) {
                const text = await res.text();
                setMessages((prev) => {
                    const copy = prev.slice();
                    copy[assistantIndex] = {
                        role: "assistant",
                        content: `【エラー】HTTP ${res.status}\n${text}`
                    };
                    return copy;
                });
                return;
            }

            if (!res.body) {
                const text = await res.text();
                setMessages((prev) => {
                    const copy = prev.slice();
                    copy[assistantIndex] = { role: "assistant", content: text };
                    return copy;
                });
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buf = "";
            let done = false;

            while (!done) {
                const { value, done: d } = await reader.read();
                done = d;
                if (value) buf += decoder.decode(value, { stream: true });

                // SSE: "data: ...\n\n" を雑にパース（行単位で data を拾う）
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;
                    const payload = trimmed.slice("data:".length).trim();
                    if (!payload) continue;
                    if (payload === "[DONE]") {
                        done = true;
                        break;
                    }

                    try {
                        const json = JSON.parse(payload);
                        const delta = json?.choices?.[0]?.delta?.content;
                        const text = typeof delta === "string" ? delta : "";
                        if (text) {
                            setMessages((prev) => {
                                const copy = prev.slice();
                                const cur = copy[assistantIndex]?.content ?? "";
                                copy[assistantIndex] = { role: "assistant", content: cur + text };
                                return copy;
                            });
                        }
                    } catch {
                        // JSON じゃない行は無視
                    }
                }
            }
        } catch (e: any) {
            setMessages((prev) => {
                const copy = prev.slice();
                copy[assistantIndex] = { role: "assistant", content: `【例外】${e?.message || String(e)}` };
                return copy;
            });
        } finally {
            setBusy(false);
        }
    }

    function reset() {
        setMessages([{ role: "system", content: "あなたは日本語で簡潔かつ正確に答えるアシスタントです。" }]);
    }

    return (
        <div className="chat">
            <div className="messages" ref={scrollRef}>
                {messages.map((m, i) => (
                    <div key={i} className={`msg ${m.role}`}>
                        <div className="badge">{m.role}</div>
                        <div style={{ marginTop: 6 }}>{m.content}</div>
                    </div>
                ))}
            </div>

            <div className="controls">
                <div className="row">
                    <div style={{ flex: 1 }}>
                        <label className="muted">temperature</label>
                        <input
                            type="number"
                            step="0.05"
                            min="0"
                            max="2"
                            value={temperature}
                            onChange={(e) => setTemperature(Number(e.target.value))}
                            disabled={busy}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label className="muted">max_tokens</label>
                        <input
                            type="number"
                            step="32"
                            min="32"
                            max="4096"
                            value={maxTokens}
                            onChange={(e) => setMaxTokens(Number(e.target.value))}
                            disabled={busy}
                        />
                    </div>
                    <div style={{ alignSelf: "end" }}>
                        <button onClick={reset} disabled={busy}>
                            Reset
                        </button>
                    </div>
                </div>

                <textarea
                    rows={4}
                    placeholder="メッセージを入力（Shift+Enterで改行 / Enterで送信）"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                    disabled={busy}
                />

                <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">
            {busy ? "生成中..." : "待機中"}
          </span>
                    <button onClick={send} disabled={!canSend}>
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
