import { getServerById } from "../../../lib/vllmServers";

export const runtime = "nodejs";

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

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const baseUrlParam = url.searchParams.get("base_url") ?? "";
        const apiKeyParam = url.searchParams.get("api_key") ?? "";
        const apiKeyHeader = req.headers.get("x-vllm-api-key") ?? "";
        const serverId = (url.searchParams.get("server_id") ?? "").trim();

        const server = serverId ? getServerById(serverId) : null;
        if (serverId && !server) {
            return new Response(JSON.stringify({ error: "Unknown server_id" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        const baseUrlOverride = normalizeBaseUrl(baseUrlParam);
        if (baseUrlParam && !baseUrlOverride) {
            return new Response(JSON.stringify({ error: "Invalid base_url" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        const baseUrl = ensureV1(server?.baseUrl ?? baseUrlOverride ?? getEnv("VLLM_BASE_URL", "http://localhost:8000/v1"))
            .replace(/\/+$/, "");
        const apiKey = server
            ? (server.apiKey ?? getEnv("VLLM_API_KEY", ""))
            : (apiKeyHeader.trim() || apiKeyParam.trim()) || getEnv("VLLM_API_KEY", "");

        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const upstream = await fetch(`${baseUrl}/models`, {
            method: "GET",
            headers,
            cache: "no-store"
        });

        const text = await upstream.text();
        return new Response(text, {
            status: upstream.status,
            headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e?.message || String(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
