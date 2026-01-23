// components/AppShell.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";

type Role = "system" | "user" | "assistant";
type MsgStatus = "done" | "streaming" | "stopped" | "error";

type ImageAttachment = {
    dataUrl: string;
    name?: string;
    mimeType?: string;
};

type ChatContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

type ModelMessage = {
    role: Role;
    content: string | ChatContentPart[];
};

type MessageMeta = {
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estTokens?: number; // usage が無い場合の推定
    model?: string;
    serverId?: string;
};

type Message = {
    id: string;
    role: Role;
    content: string;
    image?: ImageAttachment;
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
    modalities?: string[];
    thinking?: boolean;
};

type ModelOption = {
    key: string;
    id: string;
    label?: string;
    serverId?: string;
    serverName?: string;
    isVision?: boolean;
    isThinking?: boolean;
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

function normalizeModalities(raw: unknown): string[] | undefined {
    if (!raw) return undefined;
    let list: unknown = raw;

    if (raw === true) {
        return ["image", "text"];
    }

    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        try {
            list = JSON.parse(trimmed);
        } catch {
            list = trimmed.split(",").map((part) => part.trim());
        }
    }

    if (!Array.isArray(list)) return undefined;
    const out = list
        .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
        .filter(Boolean);
    return out.length ? out : undefined;
}

function normalizeBooleanFlag(raw: unknown): boolean | undefined {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed === "true") return true;
        if (trimmed === "false") return false;
    }
    return undefined;
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
            const rec = item as {
                id?: unknown;
                label?: unknown;
                name?: unknown;
                ownedBy?: unknown;
                object?: unknown;
                modalities?: unknown;
                modality?: unknown;
                input?: unknown;
                inputType?: unknown;
                vision?: unknown;
                thinking?: unknown;
                reasoning?: unknown;
                isThinking?: unknown;
            };
            const id = typeof rec.id === "string" ? rec.id.trim() : "";
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const modalities = normalizeModalities(
                rec.modalities ?? rec.modality ?? rec.input ?? rec.inputType ?? (rec.vision ? true : undefined)
            );
            const thinking = normalizeBooleanFlag(rec.thinking ?? rec.reasoning ?? rec.isThinking);
            out.push({
                id,
                label: typeof rec.label === "string" ? rec.label : typeof rec.name === "string" ? rec.name : undefined,
                ownedBy: typeof rec.ownedBy === "string" ? rec.ownedBy : undefined,
                object: typeof rec.object === "string" ? rec.object : undefined,
                modalities,
                thinking,
            });
        }
    }

    return out;
}

function isVisionModelId(id: string, modalities?: string[]): boolean {
    if (!id) return false;
    if (modalities && modalities.length > 0) {
        const norm = modalities.map((m) => m.toLowerCase());
        if (norm.some((m) => m.includes("image") || m.includes("vision") || m.includes("multimodal"))) return true;
    }
    const lower = id.toLowerCase();
    if (/(^|[-_/])vl([-.]|$)/.test(lower)) return true;
    if (lower.includes("vision") || lower.includes("multimodal") || lower.includes("image")) return true;
    return false;
}

function isThinkingModelId(id: string): boolean {
    if (!id) return false;
    const lower = id.toLowerCase();
    if (lower.includes("thinking")) return true;
    if (lower.includes("reasoning")) return true;
    if (lower.includes("reasoner")) return true;
    return false;
}

function requiresImageToken(modelId: string): boolean {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    if (lower.includes("lfm2.5-vl")) return true;
    return lower.includes("lfm2") && lower.includes("vl");
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

function IconSettings(props: { size?: number }) {
    const s = props.size ?? 16;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.2 7.2 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.3-.06.61-.06.94s.02.64.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
            />
        </svg>
    );
}

function IconPlus(props: { size?: number }) {
    const s = props.size ?? 16;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"
            />
        </svg>
    );
}

function IconClose(props: { size?: number }) {
    const s = props.size ?? 12;
    return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29 10.59 10.6 16.88 4.29z"
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
    const [pendingImage, setPendingImage] = useState<ImageAttachment | null>(null);
    const imageInputRef = useRef<HTMLInputElement | null>(null);

    const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");

    const [menuOpen, setMenuOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
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

    const hasConfiguredModels = useMemo(
        () => servers.some((server) => (server.models ?? []).length > 0),
        [servers]
    );

    const configuredModelOptions = useMemo(() => {
        const out: ModelOption[] = [];
        const seen = new Set<string>();
        for (const server of servers) {
            const modelsList = server.models ?? [];
            for (const model of modelsList) {
                const id = model.id?.trim();
                if (!id) continue;
                const key = `${server.id}::${id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const isVision = isVisionModelId(id, model.modalities);
                const isThinking = typeof model.thinking === "boolean" ? model.thinking : isThinkingModelId(id);
                out.push({
                    key,
                    id,
                    label: model.label,
                    serverId: server.id,
                    serverName: server.name,
                    isVision,
                    isThinking,
                });
            }
        }
        return out;
    }, [servers]);

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
        if (hasConfiguredModels) {
            setModels([]);
            setModelsLoading(false);
            setModelsError(null);
            return () => {
                cancelled = true;
            };
        }
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
    }, [activeConv?.serverId, servers, hasConfiguredModels]);

    const updateConv = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
        setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
    }, []);

    const defaultServerId = servers[0]?.id ?? "";

    const applyModelSelection = useCallback((value: string) => {
        if (!activeConv) return;
        const trimmed = value.trim();
        if (!trimmed) {
            updateConv(activeConv.id, (c) => ({
                ...c,
                modelId: "",
                serverId: c.serverId || defaultServerId,
                updatedAt: now(),
            }));
            return;
        }
        if (configuredModelOptions.length > 0) {
            const opt = configuredModelOptions.find((item) => item.key === trimmed);
            if (opt) {
                updateConv(activeConv.id, (c) => ({
                    ...c,
                    modelId: opt.id,
                    serverId: opt.serverId ?? c.serverId ?? defaultServerId,
                    updatedAt: now(),
                }));
                return;
            }
        }
        updateConv(activeConv.id, (c) => ({
            ...c,
            modelId: trimmed,
            updatedAt: now(),
        }));
    }, [activeConv, configuredModelOptions, defaultServerId, updateConv]);

    const resolveVisionSupport = useCallback((modelId: string, serverId?: string) => {
        const trimmed = modelId.trim();
        if (!trimmed) return false;
        const exact = configuredModelOptions.find(
            (item) => item.id === trimmed && (!serverId || item.serverId === serverId)
        );
        if (exact) return Boolean(exact.isVision);
        const any = configuredModelOptions.find((item) => item.id === trimmed);
        if (any) return Boolean(any.isVision);
        return isVisionModelId(trimmed);
    }, [configuredModelOptions]);

    const resolveThinkingSupport = useCallback((modelId: string, serverId?: string) => {
        const trimmed = modelId.trim();
        if (!trimmed) return false;
        const exact = configuredModelOptions.find(
            (item) => item.id === trimmed && (!serverId || item.serverId === serverId)
        );
        if (exact && typeof exact.isThinking === "boolean") return exact.isThinking;
        const any = configuredModelOptions.find((item) => item.id === trimmed);
        if (any && typeof any.isThinking === "boolean") return any.isThinking;
        return isThinkingModelId(trimmed);
    }, [configuredModelOptions]);

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

    useEffect(() => {
        if (!activeConv) return;
        if (!activeConv.modelId || activeConv.serverId) return;
        const opt = configuredModelOptions.find((item) => item.id === activeConv.modelId);
        if (!opt?.serverId) return;
        updateConv(activeConv.id, (c) => ({
            ...c,
            serverId: opt.serverId,
            updatedAt: now(),
        }));
    }, [activeConv, configuredModelOptions, updateConv]);

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
        messagesForModel: ModelMessage[];
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
                        ...m.meta,
                        latencyMs: t1 - t0,
                        estTokens: estimateTokens(text),
                        model: m.meta?.model ?? (params.modelId?.trim() || undefined),
                        serverId: m.meta?.serverId ?? (params.serverId?.trim() || undefined),
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
                        ...m.meta,
                        latencyMs: t1 - t0,
                        estTokens: estimateTokens(text),
                        model: m.meta?.model ?? (params.modelId?.trim() || undefined),
                        serverId: m.meta?.serverId ?? (params.serverId?.trim() || undefined),
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
    const buildMessagesForModel = useCallback((c: Conversation, supportsVision: boolean, uptoMsgId?: string) => {
        const msgs: ModelMessage[] = [];
        const needsImageToken = requiresImageToken(c.modelId ?? "");
        if (c.systemPrompt.trim().length > 0) {
            msgs.push({ role: "system", content: c.systemPrompt });
        }
        for (const m of c.messages) {
            if (m.role === "system") continue;
            let content: string | ChatContentPart[] = m.content;
            if (supportsVision && m.role === "user" && m.image?.dataUrl) {
                const parts: ChatContentPart[] = [];
                let text = m.content;
                if (needsImageToken && !text.includes("<image>")) {
                    text = text.trim().length > 0 ? `<image>\n${text}` : "<image>";
                }
                if (text.trim().length > 0) {
                    parts.push({ type: "text", text });
                }
                parts.push({ type: "image_url", image_url: { url: m.image.dataUrl } });
                content = parts;
            }
            msgs.push({ role: m.role, content });
            if (uptoMsgId && m.id === uptoMsgId) break;
        }
        return msgs;
    }, []);

    const appendUserAndRun = useCallback(async () => {
        const c = ensureActive();
        if (isStreaming) return;

        const text = input.trimEnd();
        const hasText = text.trim().length > 0;
        const hasImage = Boolean(pendingImage);
        if (!hasText && !hasImage) return;

        setInput("");
        setPendingImage(null);

        const modelId = c.modelId?.trim() || undefined;
        const serverId = c.serverId?.trim() || undefined;
        const userMsg: Message = {
            id: uid(),
            role: "user",
            content: hasText ? text : "",
            image: hasImage ? pendingImage ?? undefined : undefined,
            createdAt: now(),
            status: "done",
        };
        const assistantMsg: Message = {
            id: uid(),
            role: "assistant",
            content: "",
            createdAt: now(),
            status: "streaming",
            meta: {
                model: modelId,
                serverId,
            },
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
        const supportsVision = resolveVisionSupport(c.modelId ?? "", c.serverId);

        const latest = (() => {
            const conv = conversations.find((x) => x.id === c.id) ?? c;
            // state 反映前でも OK なように手元で組む
            const tempConv = { ...conv, messages: [...conv.messages, userMsg] };
            return buildMessagesForModel(tempConv, supportsVision);
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
    }, [ensureActive, input, pendingImage, isStreaming, updateConv, buildMessagesForModel, streamChat, conversations, resolveVisionSupport]);

    // ---- resend / regenerate without duplicating user message ----
    const runFromUserMessage = useCallback(
        async (convId: string, userMsgId: string) => {
            if (isStreaming) return;
            const conv = conversations.find((c) => c.id === convId);
            if (!conv) return;

            const userIndex = conv.messages.findIndex((m) => m.id === userMsgId && m.role === "user");
            if (userIndex < 0) return;

            const modelId = conv.modelId?.trim() || undefined;
            const serverId = conv.serverId?.trim() || undefined;
            const assistantMsg: Message = {
                id: uid(),
                role: "assistant",
                content: "",
                createdAt: now(),
                status: "streaming",
                meta: {
                    model: modelId,
                    serverId,
                },
            };

            // 重要: ユーザーメッセージは「再利用」し、以降を差し替える（複製しない）
            updateConv(convId, (c) => {
                const kept = c.messages.slice(0, userIndex + 1);
                const next = { ...c, messages: [...kept, assistantMsg], updatedAt: now() };
                return next;
            });

            // model messages: system + 先頭から userMsgId まで
            const supportsVision = resolveVisionSupport(conv.modelId ?? "", conv.serverId);
            const msgsForModel = buildMessagesForModel(conv, supportsVision, userMsgId);

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
        [isStreaming, conversations, updateConv, buildMessagesForModel, resolveVisionSupport]
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

    const onPickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            if (!result) return;
            setPendingImage({
                dataUrl: result,
                name: file.name,
                mimeType: file.type || undefined,
            });
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    }, []);

    const clearPendingImage = useCallback(() => {
        setPendingImage(null);
    }, []);

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
                        image: m.image && typeof m.image.dataUrl === "string"
                            ? {
                                dataUrl: m.image.dataUrl,
                                name: typeof m.image.name === "string" ? m.image.name : undefined,
                                mimeType: typeof m.image.mimeType === "string" ? m.image.mimeType : undefined,
                            }
                            : undefined,
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
        setPendingImage(null);
    }, []);

    const createNewChat = useCallback(() => {
        const c = newConversation();
        setConversations((prev) => [c, ...prev]);
        setActiveId(c.id);
        setMenuOpen(false);
        setEditingMsgId(null);
        setEditingText("");
        setPendingImage(null);
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

    useEffect(() => {
        if (!settingsOpen) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setSettingsOpen(false);
        }
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
        };
    }, [settingsOpen]);

    // ---- render ----
    const conv = activeConv;
    const selectedServerId = conv?.serverId ?? "";
    const selectedModelId = conv?.modelId ?? "";

    const modelOptions: ModelOption[] = configuredModelOptions.length > 0
        ? configuredModelOptions
        : models.map((model) => ({
            key: model.id,
            id: model.id,
            label: model.label,
            serverId: selectedServerId || undefined,
            serverName: selectedServerId ? (servers.find((s) => s.id === selectedServerId)?.name ?? selectedServerId) : undefined,
            isVision: isVisionModelId(model.id, model.modalities),
            isThinking: typeof model.thinking === "boolean" ? model.thinking : isThinkingModelId(model.id),
        }));

    const selectedModelKey = (() => {
        if (!selectedModelId) return "";
        if (configuredModelOptions.length > 0) {
            const exact = configuredModelOptions.find(
                (opt) => opt.id === selectedModelId && opt.serverId === selectedServerId
            );
            if (exact) return exact.key;
            const byModel = configuredModelOptions.find((opt) => opt.id === selectedModelId);
            return byModel ? byModel.key : selectedModelId;
        }
        return selectedModelId;
    })();

    const selectedModelOption = modelOptions.find((m) => m.key === selectedModelKey) ?? null;
    const hasSelectedModel = selectedModelKey.length > 0 && modelOptions.some((m) => m.key === selectedModelKey);
    const supportsVision = Boolean(
        (selectedModelOption && selectedModelOption.isVision) || isVisionModelId(selectedModelId)
    );
    const supportsThinking = typeof selectedModelOption?.isThinking === "boolean"
        ? selectedModelOption.isThinking
        : resolveThinkingSupport(selectedModelId, selectedServerId);

    const modelStatus = (() => {
        if (serversLoading) return "Loading servers...";
        if (serversError) return "Servers unavailable";
        if (!configuredModelOptions.length) {
            if (modelsLoading) return "Loading models...";
            if (modelsError) return "Models unavailable";
        }
        return "";
    })();
    const modelSelectDisabled = !conv || isStreaming || serversLoading || (!configuredModelOptions.length && modelsLoading);
    const modelInputPlaceholder = (serversLoading || modelsLoading) ? "Loading models..." : "Model ID (optional)";

    useEffect(() => {
        if (!supportsVision && pendingImage) {
            setPendingImage(null);
        }
    }, [supportsVision, pendingImage]);

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
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>Model</div>
                        <div style={{ minWidth: 220, maxWidth: 360, flex: "0 1 320px" }}>
                            {modelOptions.length > 0 ? (
                                <select
                                    value={selectedModelKey}
                                    onChange={(e) => applyModelSelection(e.target.value)}
                                    disabled={modelSelectDisabled}
                                    style={{
                                        ...inputStyle(true),
                                        width: "100%",
                                        height: 34,
                                        padding: "6px 10px",
                                        fontSize: 12,
                                    }}
                                >
                                    <option value="">Auto (server default)</option>
                                    {!hasSelectedModel && selectedModelKey ? (
                                        <option value={selectedModelKey}>{selectedModelId} (missing)</option>
                                    ) : null}
                                    {modelOptions.map((m) => {
                                        const baseLabel = m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id;
                                        const serverLabel = m.serverName ?? m.serverId;
                                        const fullLabel = serverLabel ? `${baseLabel} - ${serverLabel}` : baseLabel;
                                        return (
                                            <option key={m.key} value={m.key}>
                                                {fullLabel}
                                            </option>
                                        );
                                    })}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={selectedModelId}
                                    onChange={(e) => {
                                        if (!conv) return;
                                        updateConv(conv.id, (c) => ({ ...c, modelId: e.target.value, updatedAt: now() }));
                                    }}
                                    placeholder={modelInputPlaceholder}
                                    disabled={modelSelectDisabled}
                                    style={{
                                        ...inputStyle(true),
                                        width: "100%",
                                        height: 34,
                                        padding: "6px 10px",
                                        fontSize: 12,
                                    }}
                                />
                            )}
                        </div>
                        <IconButton
                            title="Settings"
                            onClick={() => setSettingsOpen(true)}
                            disabled={!conv}
                        >
                            <IconSettings />
                        </IconButton>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {modelStatus && (
                            <div style={{ fontSize: 11, opacity: 0.65 }}>
                                {modelStatus}
                            </div>
                        )}
                        {supportsThinking && (
                            <div
                                style={{
                                    fontSize: 10,
                                    letterSpacing: "0.08em",
                                    textTransform: "uppercase",
                                    padding: "4px 8px",
                                    borderRadius: 999,
                                    border: "1px solid rgba(255,255,255,0.18)",
                                    background: "rgba(255,255,255,0.06)",
                                    color: "rgba(255,255,255,0.8)",
                                }}
                            >
                                Thinking
                            </div>
                        )}
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            {isStreaming ? "Streaming…" : "Ready"}
                        </div>
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
                                    isThinking={resolveThinkingSupport(m.meta?.model ?? selectedModelId, m.meta?.serverId ?? selectedServerId)}
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
                    {pendingImage && (
                        <div style={{ maxWidth: 980, margin: "0 auto 8px", display: "flex" }}>
                            <div style={{ position: "relative", width: 160 }}>
                                <img
                                    src={pendingImage.dataUrl}
                                    alt={pendingImage.name || "attachment"}
                                    style={{
                                        width: "100%",
                                        borderRadius: 12,
                                        display: "block",
                                        border: "1px solid rgba(255,255,255,0.12)",
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={clearPendingImage}
                                    title="Remove image"
                                    aria-label="Remove image"
                                    style={{
                                        position: "absolute",
                                        top: 6,
                                        right: 6,
                                        width: 22,
                                        height: 22,
                                        borderRadius: 999,
                                        border: "1px solid rgba(255,255,255,0.25)",
                                        background: "rgba(0,0,0,0.6)",
                                        color: "rgba(255,255,255,0.95)",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        cursor: "pointer",
                                    }}
                                >
                                    <IconClose />
                                </button>
                            </div>
                        </div>
                    )}

                    {supportsVision && (
                        <input
                            ref={imageInputRef}
                            type="file"
                            accept="image/*"
                            onChange={onPickImage}
                            style={{ display: "none" }}
                        />
                    )}

                    <div style={{ maxWidth: 980, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
                        {supportsVision && (
                            <button
                                type="button"
                                onClick={() => imageInputRef.current?.click()}
                                disabled={isStreaming}
                                title="Attach image"
                                aria-label="Attach image"
                                style={{
                                    width: 42,
                                    height: 42,
                                    borderRadius: 12,
                                    border: "1px solid rgba(255,255,255,0.14)",
                                    background: "rgba(255,255,255,0.06)",
                                    cursor: isStreaming ? "not-allowed" : "pointer",
                                    color: "rgba(255,255,255,0.92)",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flex: "0 0 auto",
                                }}
                            >
                                <IconPlus />
                            </button>
                        )}
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

            {settingsOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) setSettingsOpen(false);
                    }}
                    style={{
                        position: "fixed",
                        inset: 0,
                        background: "rgba(6,8,12,0.65)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 60,
                        padding: 16,
                    }}
                >
                    <div
                        style={{
                            width: 560,
                            maxWidth: "100%",
                            borderRadius: 16,
                            border: "1px solid rgba(255,255,255,0.10)",
                            background: "rgba(13,17,24,0.98)",
                            boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
                            padding: 16,
                            display: "grid",
                            gap: 12,
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>Chat settings</div>
                            <button
                                type="button"
                                onClick={() => setSettingsOpen(false)}
                                style={smallBtnStyle(false)}
                            >
                                Close
                            </button>
                        </div>

                        {conv ? (
                            <div style={{ display: "grid", gap: 12 }}>
                                <label style={{ display: "grid", gap: 6 }}>
                                    <div style={{ fontSize: 12, opacity: 0.8 }}>System prompt</div>
                                    <textarea
                                        value={conv.systemPrompt}
                                        onChange={(e) =>
                                            updateConv(conv.id, (c) => ({ ...c, systemPrompt: e.target.value, updatedAt: now() }))
                                        }
                                        disabled={isStreaming}
                                        rows={4}
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
                        ) : (
                            <div style={{ fontSize: 13, opacity: 0.8 }}>No active chat.</div>
                        )}
                    </div>
                </div>
            )}
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

function splitThinkingContent(text: string) {
    const raw = typeof text === "string" ? text : "";
    const pattern = /<(thinking|think|analysis|reasoning)>([\s\S]*?)<\/\1>/gi;
    const matches = Array.from(raw.matchAll(pattern));
    if (!matches.length) {
        return { reasoning: "", answer: raw, hasReasoning: false };
    }
    const reasoning = matches
        .map((match) => match[2].trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
    pattern.lastIndex = 0;
    const answer = raw.replace(pattern, "").trim();
    return { reasoning, answer, hasReasoning: reasoning.length > 0 };
}

function MessageRow(props: {
    m: Message;
    isStreaming: boolean;
    isThinking: boolean;
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
    const hasImage = Boolean(m.image?.dataUrl);
    const showThinking = props.isThinking && isAssistant && m.status !== "streaming";
    const thinkingContent = showThinking ? splitThinkingContent(m.content) : null;
    const thinkingAnswer = thinkingContent ? thinkingContent.answer : m.content;
    const hasThinkingReasoning = Boolean(thinkingContent?.hasReasoning);
    const thinkingReasoning = thinkingContent?.reasoning ?? "";

    const bubbleBg = isUser ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)";
    const bubbleBorder = isUser ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.10)";
    const showActions = m.status !== "streaming" && !(isUser && props.isEditing);

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
                        {hasImage && (
                            <div style={{ marginBottom: (isUser && props.isEditing) || m.content.trim().length > 0 ? 10 : 0 }}>
                                <img
                                    src={m.image?.dataUrl}
                                    alt={m.image?.name || "attachment"}
                                    style={{
                                        maxWidth: "100%",
                                        borderRadius: 12,
                                        display: "block",
                                        border: "1px solid rgba(255,255,255,0.12)",
                                    }}
                                />
                            </div>
                        )}

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
                                {showThinking ? (
                                    <div style={{ display: "grid", gap: 10 }}>
                                        {hasThinkingReasoning && (
                                            <details
                                                style={{
                                                    border: "1px dashed rgba(255,255,255,0.18)",
                                                    borderRadius: 12,
                                                    padding: "8px 10px",
                                                    background: "rgba(255,255,255,0.03)",
                                                }}
                                            >
                                                <summary
                                                    style={{
                                                        cursor: "pointer",
                                                        fontSize: 12,
                                                        letterSpacing: "0.02em",
                                                        textTransform: "uppercase",
                                                        color: "rgba(255,255,255,0.72)",
                                                        outline: "none",
                                                    }}
                                                >
                                                    Thinking
                                                </summary>
                                                <div style={{ marginTop: 8 }}>
                                                    <Markdown text={thinkingReasoning} showCodeCopy={showActions} />
                                                </div>
                                            </details>
                                        )}
                                        {thinkingAnswer.trim().length > 0 ? (
                                            <Markdown text={thinkingAnswer} showCodeCopy={showActions} />
                                        ) : hasThinkingReasoning ? (
                                            <div style={{ fontSize: 13, opacity: 0.7 }}>No final answer.</div>
                                        ) : (
                                            <Markdown text={m.content} showCodeCopy={showActions} />
                                        )}
                                    </div>
                                ) : (
                                    <Markdown text={m.content} showCodeCopy={showActions} />
                                )}
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
