// components/AppShell.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";

type Role = "system" | "user" | "assistant";
type MsgStatus = "done" | "streaming" | "stopped" | "error";

type MessageMeta = {
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estTokens?: number; // usage が無い場合の推定
    model?: string;
};

type Message = {
    id: string;
    role: Role;
    content: string;
    createdAt: number;
    status: MsgStatus;
    meta?: MessageMeta;
    error?: string;
};

type Conversation = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    systemPrompt: string;
    temperature: number;
    maxTokens: number;
    modelId?: string;
    serverId?: string;
    messages: Message[];
};

type ModelInfo = {
    id: string;
    label?: string;
    ownedBy?: string;
    object?: string;
};

type ServerConfig = {
    id: string;
    name: string;
    baseUrl: string;
    models?: ModelInfo[];
};

type ExportPayload = {
    version: 1;
    app: "vllm_chat";
    exportedAt: number;
    activeId: string | null;
    conversations: Conversation[];
};

const LS_KEY = "vllm_chat_state_v1";

function now() {
    return Date.now();
}

function uid() {
    // client-only
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `id_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

function normalizeServerBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "");
}

function normalizeModelList(raw: unknown): ModelInfo[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ModelInfo[] = [];

    for (const item of raw) {
        if (typeof item === "string") {
            const id = item.trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ id });
            continue;
        }

        if (item && typeof item === "object") {
            const rec = item as { id?: unknown; label?: unknown; name?: unknown; ownedBy?: unknown; object?: unknown };
            const id = typeof rec.id === "string" ? rec.id.trim() : "";
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({
                id,
                label: typeof rec.label === "string" ? rec.label : typeof rec.name === "string" ? rec.name : undefined,
                ownedBy: typeof rec.ownedBy === "string" ? rec.ownedBy : undefined,
                object: typeof rec.object === "string" ? rec.object : undefined,
            });
        }
    }

    return out;
}

function estimateTokens(text: string) {
    // 雑だが、usage が取れない場合の「表示用」推定（約4文字=1token近似）
    return Math.max(1, Math.ceil((text ?? "").length / 4));
}

function downloadJson(obj: any, filename: string) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function copyToClipboard(text: string) {
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
            document.body.removeChild(ta);
            return true;
        } catch {
            return false;
        }
    }
}

function formatMs(ms?: number) {
    if (!ms || ms <= 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

function titleFromFirstUser(msgs: Message[]) {
    const u = msgs.find((m) => m.role === "user" && m.content.trim().length > 0);
    if (!u) return "New chat";
    const t = u.content.trim().replace(/\s+/g, " ");
    return t.length > 28 ? t.slice(0, 28) + "…" : t;
}

// ---------- Icons (small) ----------
function IconCopy(props: { size?: number }) {
    const s = props.size ?? 14;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z"
            />
        </svg>
    );
}

function IconEdit(props: { size?: number }) {
    const s = props.size ?? 14;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.83H5v-.92l9.06-9.06.92.92L5.92 20.08zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
            />
        </svg>
    );
}

function IconRefresh(props: { size?: number }) {
    const s = props.size ?? 14;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 13.65-6.65z"
            />
        </svg>
    );
}

function IconSend(props: { size?: number }) {
    const s = props.size ?? 16;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M2 21l21-9L2 3v7l15 2-15 2v7z"
            />
        </svg>
    );
}

function IconStop(props: { size?: number }) {
    const s = props.size ?? 16;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M6 6h12v12H6z" />
        </svg>
    );
}

function IconMenu(props: { size?: number }) {
    const s = props.size ?? 18;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
        </svg>
    );
}

function IconTrash(props: { size?: number }) {
    const s = props.size ?? 14;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"
            />
        </svg>
    );
}

// ---------- UI small button ----------
function IconButton(props: {
    title: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={props.title}
            aria-label={props.title}
            onClick={props.onClick}
            disabled={props.disabled}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.10)",
                background: props.disabled ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)",
                cursor: props.disabled ? "not-allowed" : "pointer",
                color: "rgba(255,255,255,0.90)",
            }}
        >
            {props.children}
        </button>
    );
}

export default function AppShell() {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);

    const [input, setInput] = useState("");
    const [isStreaming, setIsStreaming] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");

    const [menuOpen, setMenuOpen] = useState(false);
    const menuBtnRef = useRef<HTMLButtonElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const listRef = useRef<HTMLDivElement | null>(null);
    const shouldAutoScrollRef = useRef(true);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [servers, setServers] = useState<ServerConfig[]>([]);
    const [serversLoading, setServersLoading] = useState(false);
    const [serversError, setServersError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadServers() {
            setServersLoading(true);
            setServersError(null);
            setServers([]);

            try {
                const res = await fetch("/api/servers", { method: "GET", cache: "no-store" });
                const text = await res.text();
                let json: any = null;

                try {
                    json = text ? JSON.parse(text) : null;
                } catch {
                    json = null;
                }

                if (!res.ok) {
                    const msg = (json && (json.error || json.message)) ? String(json.error || json.message) : text || `HTTP ${res.status}`;
                    throw new Error(msg);
                }

                const data = Array.isArray(json?.servers) ? json.servers : [];
                const seen = new Set<string>();
                const normalized: ServerConfig[] = [];

                for (const item of data) {
                    const id = typeof item?.id === "string" ? item.id.trim() : "";
                    const baseUrl = typeof item?.baseUrl === "string"
                        ? normalizeServerBaseUrl(item.baseUrl)
                        : "";
                    if (!id || !baseUrl || seen.has(id)) continue;
                    seen.add(id);
                    normalized.push({
                        id,
                        name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : id,
                        baseUrl,
                        models: normalizeModelList(item?.models),
                    });
                }

                if (!cancelled) setServers(normalized);
            } catch (e: any) {
                if (!cancelled) {
                    setServers([]);
                    setServersError(String(e?.message ?? e));
                }
            } finally {
                if (!cancelled) setServersLoading(false);
            }
        }

        void loadServers();

        return () => {
            cancelled = true;
        };
    }, []);

    // ---- load/save localStorage ----
    useEffect(() => {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) {
                const c = newConversation();
                setConversations([c]);
                setActiveId(c.id);
                return;
            }
            const parsed = JSON.parse(raw) as {
                conversations: Conversation[];
                activeId: string | null;
            };
            if (!parsed?.conversations?.length) {
                const c = newConversation();
                setConversations([c]);
                setActiveId(c.id);
                return;
            }
            setConversations(parsed.conversations);
            setActiveId(parsed.activeId ?? parsed.conversations[0].id);
        } catch {
            const c = newConversation();
            setConversations([c]);
            setActiveId(c.id);
        }
    }, []);

    useEffect(() => {
        // debounce save
        const t = window.setTimeout(() => {
            try {
                localStorage.setItem(LS_KEY, JSON.stringify({ conversations, activeId }));
            } catch {
                // noop
            }
        }, 250);
        return () => window.clearTimeout(t);
    }, [conversations, activeId]);

    // ---- current conversation ----
    const activeConv = useMemo(() => {
        if (!activeId) return null;
        return conversations.find((c) => c.id === activeId) ?? null;
    }, [conversations, activeId]);

    useEffect(() => {
        let cancelled = false;
        const serverId = activeConv?.serverId ?? "";
        const selectedServer = serverId ? servers.find((s) => s.id === serverId) ?? null : null;
        const serverModels = selectedServer?.models ?? [];

        async function loadModels() {
            setModelsError(null);

            if (serverModels.length > 0) {
                setModels(serverModels);
                setModelsLoading(false);
                return;
            }

            setModelsLoading(true);
            setModels([]);

            try {
                const params = new URLSearchParams();
                if (serverId) params.set("server_id", serverId);
                const url = params.toString() ? `/api/models?${params.toString()}` : "/api/models";

                const res = await fetch(url, { method: "GET", cache: "no-store" });
                const text = await res.text();
                let json: any = null;

                try {
                    json = text ? JSON.parse(text) : null;
                } catch {
                    json = null;
                }

                if (!res.ok) {
                    const msg = (json && (json.error || json.message)) ? String(json.error || json.message) : text || `HTTP ${res.status}`;
                    throw new Error(msg);
                }

                if (!json || typeof json !== "object") {
                    throw new Error("Invalid models response");
                }

                const data = Array.isArray(json.data) ? json.data : [];
                const seen = new Set<string>();
                const normalized: ModelInfo[] = [];

                for (const item of data) {
                    const id = typeof item?.id === "string" ? item.id : String(item?.id ?? "");
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    normalized.push({
                        id,
                        ownedBy: typeof item?.owned_by === "string" ? item.owned_by : undefined,
                        object: typeof item?.object === "string" ? item.object : undefined,
                    });
                }

                if (!cancelled) setModels(normalized);
            } catch (e: any) {
                if (!cancelled) {
                    setModels([]);
                    setModelsError(String(e?.message ?? e));
                }
            } finally {
                if (!cancelled) setModelsLoading(false);
            }
        }

        void loadModels();

        return () => {
            cancelled = true;
        };
    }, [activeConv?.serverId, servers]);

    const updateConv = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
        setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
    }, []);

    const defaultServerId = servers[0]?.id ?? "";

    function newConversation(): Conversation {
        const t = now();
        return {
            id: uid(),
            title: "New chat",
            createdAt: t,
            updatedAt: t,
            systemPrompt: "You are a helpful assistant.",
            temperature: 0.7,
            maxTokens: 512,
            modelId: "",
            serverId: defaultServerId,
            messages: [],
        };
    }

    const ensureActive = useCallback(() => {
        if (activeConv) return activeConv;
        const c = newConversation();
        setConversations((prev) => [c, ...prev]);
        setActiveId(c.id);
        return c;
    }, [activeConv, defaultServerId]);

    // ---- auto scroll ----
    const scrollToBottom = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, []);

    const onListScroll = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 120;
        shouldAutoScrollRef.current = nearBottom;
    }, []);

    // ---- SSE parsing (OpenAI style) ----
    async function streamChat(params: {
        convId: string;
        assistantId: string;
        messagesForModel: Array<{ role: Role; content: string }>;
        temperature: number;
        maxTokens: number;
        modelId?: string;
        serverId?: string;
    }) {
        const t0 = now();
        setIsStreaming(true);

        const ac = new AbortController();
        abortRef.current = ac;

        try {
            const payload: any = {
                messages: params.messagesForModel,
                stream: true,
                temperature: params.temperature,
                max_tokens: params.maxTokens,
            };

            const modelId = params.modelId?.trim();
            if (modelId) payload.model = modelId;
            const serverId = params.serverId?.trim();
            if (serverId) payload.server_id = serverId;

            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: ac.signal,
                body: JSON.stringify(payload),
            });

            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text || "stream failed"}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let finalUsage: any = null;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // SSE は \n 区切りの行として処理（data: ...）
                // OpenAI互換では data: {json}\n\n ... data: [DONE]\n\n
                let idx: number;
                while ((idx = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, idx).trimEnd();
                    buffer = buffer.slice(idx + 1);

                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;

                    const data = trimmed.slice(5).trim();
                    if (!data) continue;

                    if (data === "[DONE]") {
                        break;
                    }

                    let obj: any;
                    try {
                        obj = JSON.parse(data);
                    } catch {
                        continue;
                    }

                    // delta content
                    const delta = obj?.choices?.[0]?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                        updateConv(params.convId, (c) => {
                            const msgs = c.messages.map((m) =>
                                m.id === params.assistantId
                                    ? { ...m, content: m.content + delta, status: "streaming" as MsgStatus }
                                    : m
                            );
                            return { ...c, messages: msgs, updatedAt: now() };
                        });
                        if (shouldAutoScrollRef.current) requestAnimationFrame(scrollToBottom);
                    }

                    // usage が取れるなら保持
                    if (obj?.usage) finalUsage = obj.usage;
                }
            }

            const t1 = now();
            updateConv(params.convId, (c) => {
                const msgs = c.messages.map((m) => {
                    if (m.id !== params.assistantId) return m;
                    const text = m.content ?? "";
                    const meta: MessageMeta = {
                        latencyMs: t1 - t0,
                        estTokens: estimateTokens(text),
                    };
                    if (finalUsage) {
                        meta.promptTokens = finalUsage.prompt_tokens;
                        meta.completionTokens = finalUsage.completion_tokens;
                        meta.totalTokens = finalUsage.total_tokens;
                    }
                    return { ...m, status: "done" as MsgStatus, meta };
                });
                const title = c.messages.length === 0 ? titleFromFirstUser(msgs) : c.title;
                return { ...c, title, messages: msgs, updatedAt: now() };
            });
        } catch (e: any) {
            const stopped = e?.name === "AbortError";
            const t1 = now();

            updateConv(params.convId, (c) => {
                const msgs = c.messages.map((m) => {
                    if (m.id !== params.assistantId) return m;

                    const text = m.content ?? "";
                    const meta: MessageMeta = {
                        latencyMs: t1 - t0,
                        estTokens: estimateTokens(text),
                    };

                    if (stopped) return { ...m, status: "stopped" as MsgStatus, meta };
                    return { ...m, status: "error" as MsgStatus, error: String(e?.message ?? e), meta };
                });
                return { ...c, messages: msgs, updatedAt: now() };
            });
        } finally {
            setIsStreaming(false);
            abortRef.current = null;
        }
    }

    const stopStreaming = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    // ---- message helpers ----
    const buildMessagesForModel = useCallback((c: Conversation, uptoMsgId?: string) => {
        const msgs: Array<{ role: Role; content: string }> = [];
        if (c.systemPrompt.trim().length > 0) {
            msgs.push({ role: "system", content: c.systemPrompt });
        }
        for (const m of c.messages) {
            if (uptoMsgId && m.id === uptoMsgId) {
                // uptoMsgId は「含める」側で扱う（呼び出し側で調整）
            }
            if (m.role === "system") continue;
            msgs.push({ role: m.role, content: m.content });
            if (uptoMsgId && m.id === uptoMsgId) break;
        }
        return msgs;
    }, []);

    const appendUserAndRun = useCallback(async () => {
        const c = ensureActive();
        if (isStreaming) return;

        const text = input.trimEnd();
        if (text.trim().length === 0) return;

        setInput("");

        const userMsg: Message = {
            id: uid(),
            role: "user",
            content: text,
            createdAt: now(),
            status: "done",
        };
        const assistantMsg: Message = {
            id: uid(),
            role: "assistant",
            content: "",
            createdAt: now(),
            status: "streaming",
        };

        updateConv(c.id, (conv) => {
            const next = {
                ...conv,
                messages: [...conv.messages, userMsg, assistantMsg],
                updatedAt: now(),
            };
            if (next.title === "New chat") next.title = titleFromFirstUser(next.messages);
            return next;
        });

        // モデルに渡す messages は「今追加した user まで」を含める
        const latest = (() => {
            const conv = conversations.find((x) => x.id === c.id) ?? c;
            // state 反映前でも OK なように手元で組む
            const tempConv = { ...conv, messages: [...conv.messages, userMsg] };
            return buildMessagesForModel(tempConv);
        })();

        await streamChat({
            convId: c.id,
            assistantId: assistantMsg.id,
            messagesForModel: latest,
            temperature: c.temperature,
            maxTokens: c.maxTokens,
            modelId: c.modelId,
            serverId: c.serverId,
        });
    }, [ensureActive, input, isStreaming, updateConv, buildMessagesForModel, streamChat, conversations]);

    // ---- resend / regenerate without duplicating user message ----
    const runFromUserMessage = useCallback(
        async (convId: string, userMsgId: string) => {
            if (isStreaming) return;
            const conv = conversations.find((c) => c.id === convId);
            if (!conv) return;

            const userIndex = conv.messages.findIndex((m) => m.id === userMsgId && m.role === "user");
            if (userIndex < 0) return;

            const assistantMsg: Message = {
                id: uid(),
                role: "assistant",
                content: "",
                createdAt: now(),
                status: "streaming",
            };

            // 重要: ユーザーメッセージは「再利用」し、以降を差し替える（複製しない）
            updateConv(convId, (c) => {
                const kept = c.messages.slice(0, userIndex + 1);
                const next = { ...c, messages: [...kept, assistantMsg], updatedAt: now() };
                return next;
            });

            // model messages: system + 先頭から userMsgId まで
            const msgsForModel = buildMessagesForModel(conv, userMsgId);

            await streamChat({
                convId,
                assistantId: assistantMsg.id,
                messagesForModel: msgsForModel,
                temperature: conv.temperature,
                maxTokens: conv.maxTokens,
                modelId: conv.modelId,
                serverId: conv.serverId,
            });
        },
        [isStreaming, conversations, updateConv, buildMessagesForModel]
    );

    const regenerateFromAssistant = useCallback(
        async (convId: string, assistantMsgId: string) => {
            const conv = conversations.find((c) => c.id === convId);
            if (!conv) return;

            const idx = conv.messages.findIndex((m) => m.id === assistantMsgId && m.role === "assistant");
            if (idx < 0) return;

            // 直前の user を探す
            for (let i = idx - 1; i >= 0; i--) {
                const m = conv.messages[i];
                if (m.role === "user") {
                    await runFromUserMessage(convId, m.id);
                    return;
                }
            }
        },
        [conversations, runFromUserMessage]
    );

    // ---- edit user message ----
    const startEdit = useCallback((m: Message) => {
        setEditingMsgId(m.id);
        setEditingText(m.content);
    }, []);

    const cancelEdit = useCallback(() => {
        setEditingMsgId(null);
        setEditingText("");
    }, []);

    const saveEdit = useCallback(async () => {
        if (!activeConv || !editingMsgId) return;
        if (isStreaming) return;

        const convId = activeConv.id;
        const newText = editingText.trimEnd();

        const conv = conversations.find((c) => c.id === convId);
        if (!conv) return;

        const idx = conv.messages.findIndex((m) => m.id === editingMsgId && m.role === "user");
        if (idx < 0) return;

        // user を更新し、それ以降を差し替える（複製しない）
        updateConv(convId, (c) => {
            const kept = c.messages.slice(0, idx + 1).map((m) =>
                m.id === editingMsgId ? { ...m, content: newText } : m
            );
            const next = { ...c, messages: kept, updatedAt: now() };
            if (next.title === "New chat") next.title = titleFromFirstUser(next.messages);
            return next;
        });

        setEditingMsgId(null);
        setEditingText("");

        await runFromUserMessage(convId, editingMsgId);
    }, [activeConv, editingMsgId, editingText, isStreaming, conversations, updateConv, runFromUserMessage]);

    // ---- export/import ----
    const exportCurrent = useCallback(() => {
        if (!activeConv) return;
        const payload: ExportPayload = {
            version: 1,
            app: "vllm_chat",
            exportedAt: now(),
            activeId,
            conversations: [activeConv],
        };
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(payload, `vllm_chat_export_current_${ts}.json`);
        setMenuOpen(false);
    }, [activeConv, activeId]);

    const exportAll = useCallback(() => {
        const payload: ExportPayload = {
            version: 1,
            app: "vllm_chat",
            exportedAt: now(),
            activeId,
            conversations,
        };
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(payload, `vllm_chat_export_all_${ts}.json`);
        setMenuOpen(false);
    }, [conversations, activeId]);

    const triggerImport = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onImportFile = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // 同じファイル連続選択対策
            if (!file) return;

            let txt = "";
            try {
                txt = await file.text();
            } catch {
                return;
            }

            let parsed: any;
            try {
                parsed = JSON.parse(txt);
            } catch {
                return;
            }

            // 期待形式: ExportPayload
            const imported: Conversation[] = Array.isArray(parsed?.conversations) ? parsed.conversations : [];

            if (!imported.length) return;

            // ID衝突回避: 既存IDセット
            const existingIds = new Set(conversations.map((c) => c.id));
            const sanitized = imported.map((c) => {
                const id = existingIds.has(c.id) ? uid() : c.id;
                const msgs = Array.isArray(c.messages) ? c.messages : [];
                return {
                    ...c,
                    id,
                    createdAt: typeof c.createdAt === "number" ? c.createdAt : now(),
                    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : now(),
                    title: typeof c.title === "string" ? c.title : titleFromFirstUser(msgs),
                    systemPrompt: typeof c.systemPrompt === "string" ? c.systemPrompt : "You are a helpful assistant.",
                    temperature: typeof c.temperature === "number" ? clamp(c.temperature, 0, 2) : 0.7,
                    maxTokens: typeof c.maxTokens === "number" ? clamp(c.maxTokens, 16, 4096) : 512,
                    modelId: typeof c.modelId === "string" ? c.modelId : "",
                    serverId: typeof c.serverId === "string" ? c.serverId : "",
                    messages: msgs.map((m: any) => ({
                        id: typeof m.id === "string" ? m.id : uid(),
                        role: (m.role === "user" || m.role === "assistant" || m.role === "system") ? m.role : "user",
                        content: typeof m.content === "string" ? m.content : "",
                        createdAt: typeof m.createdAt === "number" ? m.createdAt : now(),
                        status: (m.status === "done" || m.status === "streaming" || m.status === "stopped" || m.status === "error")
                            ? m.status
                            : "done",
                        meta: m.meta,
                        error: m.error,
                    })),
                } as Conversation;
            });

            setConversations((prev) => [...sanitized, ...prev]);
            setActiveId(sanitized[0].id);
            setMenuOpen(false);
        },
        [conversations]
    );

    const clearAll = useCallback(() => {
        if (!confirm("ローカルの会話をすべて削除します。よろしいですか？")) return;
        const c = newConversation();
        setConversations([c]);
        setActiveId(c.id);
        setMenuOpen(false);
        setEditingMsgId(null);
        setEditingText("");
        setIsStreaming(false);
        abortRef.current?.abort();
        abortRef.current = null;
        setInput("");
    }, []);

    const createNewChat = useCallback(() => {
        const c = newConversation();
        setConversations((prev) => [c, ...prev]);
        setActiveId(c.id);
        setMenuOpen(false);
        setEditingMsgId(null);
        setEditingText("");
        requestAnimationFrame(scrollToBottom);
    }, [scrollToBottom, defaultServerId]);

    const deleteChat = useCallback((id: string) => {
        if (!confirm("このチャットを削除します。よろしいですか？")) return;
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (activeId === id) {
            setActiveId((prev) => {
                const rest = conversations.filter((c) => c.id !== id);
                return rest.length ? rest[0].id : null;
            });
        }
    }, [activeId, conversations]);

    // ---- close menu on outside click / esc ----
    useEffect(() => {
        function onDown(e: MouseEvent) {
            if (!menuOpen) return;
            const btn = menuBtnRef.current;
            const pop = document.getElementById("sidebar-popover");
            if (!btn || !pop) return;
            const t = e.target as Node;
            if (btn.contains(t) || pop.contains(t)) return;
            setMenuOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setMenuOpen(false);
        }
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    // ---- render ----
    const conv = activeConv;
    const selectedServerId = conv?.serverId ?? "";
    const selectedServer = selectedServerId ? servers.find((s) => s.id === selectedServerId) ?? null : null;
    const hasSelectedServer = selectedServerId.length > 0 && servers.some((s) => s.id === selectedServerId);
    const selectedModelId = conv?.modelId ?? "";
    const hasSelectedModel = selectedModelId.length > 0 && models.some((m) => m.id === selectedModelId);

    return (
        <div
            style={{
                height: "100vh",
                display: "grid",
                gridTemplateColumns: "320px 1fr",
                background: "#0b0f14",
                color: "rgba(255,255,255,0.92)",
                fontFamily:
                    'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
            }}
        >
            {/* Sidebar */}
            <aside
                style={{
                    borderRight: "1px solid rgba(255,255,255,0.08)",
                    background: "#0a0e13",
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                }}
            >
                <div style={{ padding: 12, display: "flex", gap: 10, alignItems: "center" }}>
                    <button
                        type="button"
                        onClick={createNewChat}
                        style={{
                            flex: 1,
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: "1px solid rgba(255,255,255,0.10)",
                            background: "rgba(255,255,255,0.06)",
                            cursor: "pointer",
                            color: "rgba(255,255,255,0.92)",
                            fontWeight: 600,
                        }}
                    >
                        New chat
                    </button>

                    <button
                        ref={menuBtnRef}
                        type="button"
                        onClick={() => setMenuOpen((v) => !v)}
                        title="Menu"
                        aria-label="Menu"
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            border: "1px solid rgba(255,255,255,0.10)",
                            background: "rgba(255,255,255,0.06)",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <IconMenu />
                    </button>
                </div>

                {/* Popover */}
                {menuOpen && (
                    <div
                        id="sidebar-popover"
                        style={{
                            position: "absolute",
                            left: 12,
                            top: 64,
                            width: 296,
                            zIndex: 50,
                            borderRadius: 14,
                            border: "1px solid rgba(255,255,255,0.10)",
                            background: "rgba(15,19,26,0.98)",
                            boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
                            padding: 10,
                        }}
                    >
                        <div style={{ display: "grid", gap: 8 }}>
                            <MenuRow label="Export current chat" onClick={exportCurrent} />
                            <MenuRow label="Export all chats" onClick={exportAll} />
                            <MenuRow label="Import chats (JSON)" onClick={triggerImport} />
                            <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "6px 0" }} />
                            <MenuRow label="Clear all local data" onClick={clearAll} danger />
                        </div>
                    </div>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json"
                    style={{ display: "none" }}
                    onChange={onImportFile}
                />

                <div style={{ padding: "10px 12px", opacity: 0.8, fontSize: 12 }}>
                    Chats
                </div>

                <div style={{ overflowY: "auto", padding: 10, display: "grid", gap: 8 }}>
                    {conversations.map((c) => {
                        const active = c.id === activeId;
                        return (
                            <div
                                key={c.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    borderRadius: 12,
                                    border: `1px solid ${active ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)"}`,
                                    background: active ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                                    padding: "10px 10px",
                                    cursor: "pointer",
                                }}
                            >
                                <div
                                    onClick={() => setActiveId(c.id)}
                                    style={{ flex: 1, minWidth: 0 }}
                                    title={c.title}
                                >
                                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {c.title || "Untitled"}
                                    </div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                                        {new Date(c.updatedAt).toLocaleString()}
                                    </div>
                                </div>

                                <IconButton
                                    title="Delete chat"
                                    onClick={() => deleteChat(c.id)}
                                    disabled={isStreaming && active}
                                >
                                    <IconTrash />
                                </IconButton>
                            </div>
                        );
                    })}
                </div>

                {/* Sidebar settings for active conversation */}
                {conv && (
                    <div
                        style={{
                            borderTop: "1px solid rgba(255,255,255,0.08)",
                            padding: 12,
                            display: "grid",
                            gap: 10,
                        }}
                    >
                        <div style={{ fontSize: 12, opacity: 0.85 }}>Chat settings</div>

                        <label style={{ display: "grid", gap: 6 }}>
                            <div style={{ fontSize: 12, opacity: 0.8 }}>Server</div>
                            <select
                                value={selectedServerId}
                                onChange={(e) =>
                                    updateConv(conv.id, (c) => ({ ...c, serverId: e.target.value, updatedAt: now() }))
                                }
                                disabled={isStreaming || serversLoading}
                                style={inputStyle(true)}
                            >
                                <option value="">Default (env)</option>
                                {!hasSelectedServer && selectedServerId ? (
                                    <option value={selectedServerId}>{selectedServerId} (missing)</option>
                                ) : null}
                                {servers.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {s.name || s.baseUrl}
                                    </option>
                                ))}
                            </select>
                            {selectedServer && (
                                <div style={{ fontSize: 11, opacity: 0.65 }}>
                                    Base: {selectedServer.baseUrl}
                                </div>
                            )}
                            {serversLoading && (
                                <div style={{ fontSize: 11, opacity: 0.65 }}>Loading servers...</div>
                            )}
                            {!serversLoading && serversError && (
                                <div style={{ fontSize: 11, color: "rgba(255,180,180,0.95)" }}>
                                    Servers unavailable
                                </div>
                            )}
                        </label>

                        <label style={{ display: "grid", gap: 6 }}>
                            <div style={{ fontSize: 12, opacity: 0.8 }}>Model</div>
                            {models.length > 0 ? (
                                <select
                                    value={selectedModelId}
                                    onChange={(e) =>
                                        updateConv(conv.id, (c) => ({ ...c, modelId: e.target.value, updatedAt: now() }))
                                    }
                                    disabled={isStreaming}
                                    style={inputStyle(true)}
                                >
                                    <option value="">Auto (server default)</option>
                                    {!hasSelectedModel && selectedModelId ? (
                                        <option value={selectedModelId}>{selectedModelId} (missing)</option>
                                    ) : null}
                                    {models.map((m) => (
                                        <option key={m.id} value={m.id}>
                                            {m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={selectedModelId}
                                    onChange={(e) =>
                                        updateConv(conv.id, (c) => ({ ...c, modelId: e.target.value, updatedAt: now() }))
                                    }
                                    placeholder={modelsLoading ? "Loading models..." : "Model ID (optional)"}
                                    disabled={isStreaming || modelsLoading}
                                    style={inputStyle(true)}
                                />
                            )}
                            {modelsLoading && (
                                <div style={{ fontSize: 11, opacity: 0.65 }}>Loading models...</div>
                            )}
                            {!modelsLoading && modelsError && (
                                <div
                                    style={{
                                        fontSize: 11,
                                        opacity: 0.85,
                                        color: "rgba(255,180,180,0.95)",
                                    }}
                                    title={modelsError}
                                >
                                    Models unavailable
                                </div>
                            )}
                        </label>

                        <label style={{ display: "grid", gap: 6 }}>
                            <div style={{ fontSize: 12, opacity: 0.8 }}>System prompt</div>
                            <textarea
                                value={conv.systemPrompt}
                                onChange={(e) =>
                                    updateConv(conv.id, (c) => ({ ...c, systemPrompt: e.target.value, updatedAt: now() }))
                                }
                                disabled={isStreaming}
                                rows={3}
                                style={inputStyle()}
                            />
                        </label>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <label style={{ display: "grid", gap: 6 }}>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>Temperature</div>
                                <input
                                    type="number"
                                    step="0.1"
                                    min="0"
                                    max="2"
                                    value={conv.temperature}
                                    onChange={(e) =>
                                        updateConv(conv.id, (c) => ({ ...c, temperature: clamp(Number(e.target.value), 0, 2), updatedAt: now() }))
                                    }
                                    disabled={isStreaming}
                                    style={inputStyle(true)}
                                />
                            </label>

                            <label style={{ display: "grid", gap: 6 }}>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>Max tokens</div>
                                <input
                                    type="number"
                                    step="16"
                                    min="16"
                                    max="4096"
                                    value={conv.maxTokens}
                                    onChange={(e) =>
                                        updateConv(conv.id, (c) => ({ ...c, maxTokens: clamp(Number(e.target.value), 16, 4096), updatedAt: now() }))
                                    }
                                    disabled={isStreaming}
                                    style={inputStyle(true)}
                                />
                            </label>
                        </div>
                    </div>
                )}
            </aside>

            {/* Main */}
            <main style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: "100vh", position: "relative" }}>
                {/* Header */}
                <header
                    style={{
                        height: 56,
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0 16px",
                        background: "rgba(10,14,19,0.65)",
                        backdropFilter: "blur(10px)",
                    }}
                >
                    <div style={{ fontWeight: 700, fontSize: 14, opacity: 0.95 }}>
                        {conv?.title ?? "Chat"}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {isStreaming ? "Streaming…" : "Ready"}
                    </div>
                </header>

                {/* Messages */}
                <div
                    ref={listRef}
                    onScroll={onListScroll}
                    className="chatScroll"
                    style={{
                        flex: 1,
                        padding: "18px 18px 120px",
                    }}
                >
                    <div style={{ maxWidth: 980, margin: "0 auto", display: "grid", gap: 14 }}>
                        {conv?.messages?.length ? (
                            conv.messages.map((m) => (
                                <MessageRow
                                    key={m.id}
                                    m={m}
                                    isStreaming={isStreaming}
                                    isEditing={editingMsgId === m.id}
                                    editingText={editingText}
                                    onEditingTextChange={setEditingText}
                                    onCopy={async () => { await copyToClipboard(m.content); }}
                                    onEdit={() => startEdit(m)}
                                    onCancelEdit={cancelEdit}
                                    onSaveEdit={saveEdit}
                                    onResend={() => runFromUserMessage(conv.id, m.id)}
                                    onRegenerate={() => regenerateFromAssistant(conv.id, m.id)}
                                />
                            ))
                        ) : (
                            <div style={{ opacity: 0.75, padding: "22px 6px" }}>
                                Start a conversation.
                            </div>
                        )}
                    </div>
                </div>

                {/* Composer */}
                <div
                    style={{
                        position: "sticky",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        borderTop: "1px solid rgba(255,255,255,0.08)",
                        padding: 14,
                        background: "rgba(10,14,19,0.85)",
                        backdropFilter: "blur(10px)",
                        boxShadow: "0 -10px 30px rgba(0,0,0,0.45)",
                        zIndex: 5,
                    }}
                >
                    <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
            <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message"
                rows={2}
                disabled={isStreaming}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        appendUserAndRun();
                    }
                }}
                style={{
                    flex: 1,
                    resize: "none",
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(255,255,255,0.05)",
                    padding: "12px 12px",
                    color: "rgba(255,255,255,0.92)",
                    outline: "none",
                    lineHeight: 1.45,
                    minHeight: 44,
                }}
            />

                        {isStreaming ? (
                            <button
                                type="button"
                                onClick={stopStreaming}
                                style={primaryBtnStyle(true)}
                                title="Stop"
                            >
                                <IconStop />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={appendUserAndRun}
                                style={primaryBtnStyle(false)}
                                title="Send"
                            >
                                <IconSend />
                            </button>
                        )}
                    </div>

                    <div style={{ maxWidth: 980, margin: "8px auto 0", fontSize: 12, opacity: 0.7 }}>
                        Enter to send, Shift+Enter for newline.
                    </div>
                </div>
            </main>
        </div>
    );
}

function MenuRow(props: { label: string; onClick: () => void; danger?: boolean }) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            style={{
                width: "100%",
                textAlign: "left",
                padding: "10px 10px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.10)",
                background: props.danger ? "rgba(255,80,80,0.12)" : "rgba(255,255,255,0.06)",
                color: props.danger ? "rgba(255,190,190,0.95)" : "rgba(255,255,255,0.92)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
            }}
        >
            {props.label}
        </button>
    );
}

function inputStyle(isOneLine?: boolean): React.CSSProperties {
    return {
        width: "100%",
        resize: "vertical",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.05)",
        padding: isOneLine ? "10px 10px" : "10px 10px",
        color: "rgba(255,255,255,0.92)",
        outline: "none",
        fontSize: 13,
        lineHeight: 1.35,
    };
}

function primaryBtnStyle(isStop: boolean): React.CSSProperties {
    return {
        width: 46,
        height: 46,
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.14)",
        background: isStop ? "rgba(255,120,120,0.16)" : "rgba(255,255,255,0.10)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.92)",
        flex: "0 0 auto",
    };
}

function MessageRow(props: {
    m: Message;
    isStreaming: boolean;
    isEditing: boolean;
    editingText: string;
    onEditingTextChange: (v: string) => void;
    onCopy: () => void;
    onEdit: () => void;
    onCancelEdit: () => void;
    onSaveEdit: () => void;
    onResend: () => void; // user message resend
    onRegenerate: () => void; // assistant regenerate
}) {
    const m = props.m;
    const isUser = m.role === "user";
    const isAssistant = m.role === "assistant";

    const bubbleBg = isUser ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)";
    const bubbleBorder = isUser ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.10)";
    const showActions = !(isUser && props.isEditing);

    const bubbleStyle: React.CSSProperties = {
        borderRadius: 16,
        border: `1px solid ${bubbleBorder}`,
        background: bubbleBg,
        padding: showActions ? "14px 14px 46px 14px" : 14,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        position: "relative",
    };

    const metaLine = (() => {
        if (!isAssistant) return "";
        const lat = formatMs(m.meta?.latencyMs);
        const tokens = m.meta?.totalTokens
            ? `tokens: ${m.meta.totalTokens}`
            : m.meta?.estTokens
                ? `tokens: ~${m.meta.estTokens}`
                : "";
        const parts = [lat, tokens].filter(Boolean);
        return parts.join(" • ");
    })();

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <div
                style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    justifyContent: isUser ? "flex-end" : "flex-start",
                }}
            >
                <div style={{ maxWidth: "82%", width: "fit-content" }}>
                    <div style={bubbleStyle}>
                        {isUser && props.isEditing ? (
                            <div style={{ display: "grid", gap: 10 }}>
                <textarea
                    value={props.editingText}
                    onChange={(e) => props.onEditingTextChange(e.target.value)}
                    rows={4}
                    style={{
                        width: "100%",
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.05)",
                        padding: 10,
                        color: "rgba(255,255,255,0.92)",
                        outline: "none",
                        lineHeight: 1.45,
                    }}
                />
                                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                    <button
                                        type="button"
                                        onClick={props.onCancelEdit}
                                        style={smallBtnStyle(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={props.onSaveEdit}
                                        style={smallBtnStyle(true)}
                                        disabled={props.isStreaming}
                                    >
                                        Save & regenerate
                                    </button>
                                </div>
                            </div>
                        ) : isAssistant ? (
                            <>
                                <Markdown text={m.content} />
                                {m.status === "error" && m.error && (
                                    <div style={{ marginTop: 10, color: "rgba(255,180,180,0.95)", fontSize: 13 }}>
                                        Error: {m.error}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div>{m.content}</div>
                        )}

                        {showActions && (
                            <div
                                style={{
                                    position: "absolute",
                                    bottom: 10,
                                    left: isAssistant ? 12 : "auto",
                                    right: isUser ? 12 : "auto",
                                    display: "flex",
                                    gap: 8,
                                    paddingTop: 6,
                                    alignItems: "center",
                                }}
                            >
                                <IconButton title="Copy" onClick={props.onCopy}>
                                    <IconCopy />
                                </IconButton>

                                {isUser && !props.isEditing && (
                                    <>
                                        <IconButton title="Edit" onClick={props.onEdit} disabled={props.isStreaming}>
                                            <IconEdit />
                                        </IconButton>
                                        <IconButton title="Resend" onClick={props.onResend} disabled={props.isStreaming}>
                                            <IconRefresh />
                                        </IconButton>
                                    </>
                                )}

                                {isAssistant && (
                                    <IconButton title="Regenerate" onClick={props.onRegenerate} disabled={props.isStreaming}>
                                        <IconRefresh />
                                    </IconButton>
                                )}
                            </div>
                        )}
                    </div>

                    {isAssistant && metaLine && (
                        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                            {metaLine}
                        </div>
                    )}

                    {isAssistant && m.status === "stopped" && (
                        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                            Stopped.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function smallBtnStyle(primary: boolean): React.CSSProperties {
    return {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: primary ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.05)",
        color: "rgba(255,255,255,0.92)",
        cursor: "pointer",
        fontWeight: 700,
        fontSize: 12,
    };
}
