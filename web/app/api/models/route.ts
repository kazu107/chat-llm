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

        const upstream = await fetch(`${baseUrl}/models`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${apiKey}`
            },
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
