export const runtime = "nodejs";

function mustGetEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export async function GET() {
    try {
        const baseUrl = (process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "");
        const apiKey = mustGetEnv("VLLM_API_KEY");

        // baseUrlは /v1 前提。/health は 1段上
        const root = baseUrl.replace(/\/v1$/, "");
        const upstream = await fetch(`${root}/health`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${apiKey}` },
            cache: "no-store"
        });

        if (!upstream.ok) {
            return new Response(JSON.stringify({ ok: false, detail: `HTTP ${upstream.status}` }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ ok: true, detail: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, detail: e?.message || String(e) }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    }
}
