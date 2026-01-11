// app/api/chat/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatRequest = {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    model?: string;
};

function getEnv(name: string, fallback: string) {
    const v = process.env[name];
    return (v && v.trim().length > 0) ? v.trim() : fallback;
}

export async function POST(req: Request) {
    let body: ChatRequest;
    try {
        body = (await req.json()) as ChatRequest;
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const baseUrl = getEnv("VLLM_BASE_URL", "http://vllm-lfm25-jp:8000/v1"); // docker compose network内想定
    const model = body.model ?? getEnv("VLLM_MODEL", "LiquidAI/LFM2.5-1.2B-JP");
    const apiKey = getEnv("VLLM_API_KEY", "EMPTY");

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
        upstream = await fetch(upstreamUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(upstreamPayload),
            signal: req.signal, // クライアントが中断したら upstream も止まる
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
