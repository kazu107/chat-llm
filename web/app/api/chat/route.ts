// app/api/chat/route.ts
import { NextResponse } from "next/server";
import { getServerById } from "../../../lib/vllmServers";

export const runtime = "nodejs";

type ChatRequest = {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    model?: string;
    base_url?: string;
    api_key?: string;
    server_id?: string;
};

function getEnv(name: string, fallback: string) {
    const v = process.env[name];
    return (v && v.trim().length > 0) ? v.trim() : fallback;
}

function normalizeBaseUrl(raw?: string) {
    if (!raw) return null;
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
        new URL(trimmed);
        return trimmed;
    } catch {
        return null;
    }
}

function ensureV1(baseUrl: string) {
    return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export async function POST(req: Request) {
    let body: ChatRequest;
    try {
        body = (await req.json()) as ChatRequest;
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const serverId = typeof body.server_id === "string" ? body.server_id.trim() : "";
    const server = serverId ? getServerById(serverId) : null;
    if (serverId && !server) {
        return NextResponse.json({ error: "Unknown server_id" }, { status: 400 });
    }

    const baseUrlOverride = normalizeBaseUrl(body.base_url);
    if (body.base_url && !baseUrlOverride) {
        return NextResponse.json({ error: "Invalid base_url" }, { status: 400 });
    }

    const baseUrl = ensureV1(
        server?.baseUrl ?? baseUrlOverride ?? getEnv("VLLM_BASE_URL", "http://vllm-lfm25-jp:8000/v1")
    );
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const fallbackModel = server?.models?.[0]?.id ?? getEnv("VLLM_MODEL", "LiquidAI/LFM2.5-1.2B-JP");
    const model = requestedModel || fallbackModel;
    const apiKey = server
        ? (server.apiKey ?? getEnv("VLLM_API_KEY", ""))
        : (typeof body.api_key === "string" ? body.api_key.trim() : "") || getEnv("VLLM_API_KEY", "");

    const upstreamUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

    // vLLM は OpenAI互換の ChatCompletions を受ける想定。
    const upstreamPayload: any = {
        model,
        messages: body.messages ?? [],
        stream: Boolean(body.stream),
        temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 512,
    };

    // usage がストリームで取れる場合は取る（取れない実装もあるのでクライアントでフォールバック）
    if (upstreamPayload.stream) {
        upstreamPayload.stream_options = { include_usage: true };
    }

    let upstream: Response;
    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        upstream = await fetch(upstreamUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamPayload),
            signal: req.signal, // ????????????Eupstream ????E
        });
    } catch (e: any) {
        return NextResponse.json(
            { error: "Failed to reach vLLM server", detail: String(e?.message ?? e) },
            { status: 502 }
        );
    }

    if (!upstream.ok) {
        let txt = "";
        try {
            txt = await upstream.text();
        } catch {
            // noop
        }
        return NextResponse.json(
            { error: "Upstream error", status: upstream.status, body: txt },
            { status: 502 }
        );
    }

    // streaming: SSE をそのまま透過
    if (upstreamPayload.stream) {
        const headers = new Headers();
        headers.set("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
        headers.set("Cache-Control", "no-cache, no-transform");
        headers.set("Connection", "keep-alive");

        return new Response(upstream.body, {
            status: 200,
            headers,
        });
    }

    // non-stream
    const json = await upstream.json();
    return NextResponse.json(json, { status: 200 });
}
