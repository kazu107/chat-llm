export type ServerModel = {
    id: string;
    label?: string;
    modalities?: string[];
    thinking?: boolean;
};

export type VllmServer = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    models?: ServerModel[];
};

type RawServer = {
    id?: unknown;
    name?: unknown;
    baseUrl?: unknown;
    base_url?: unknown;
    apiKey?: unknown;
    api_key?: unknown;
    models?: unknown;
    modelIds?: unknown;
    model_ids?: unknown;
};

function normalizeBaseUrl(value: string): string | null {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
        new URL(trimmed);
        return trimmed;
    } catch {
        return null;
    }
}

function normalizeModalities(raw: unknown): string[] | undefined {
    if (!raw) return undefined;
    let list: unknown = raw;

    if (raw === true) return ["image", "text"];

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

function normalizeModels(raw: unknown): ServerModel[] | undefined {
    if (!raw) return undefined;
    let list: unknown = raw;

    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        try {
            list = JSON.parse(trimmed);
        } catch {
            list = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
        }
    }

    if (!Array.isArray(list)) return undefined;

    const seen = new Set<string>();
    const out: ServerModel[] = [];

    for (const item of list) {
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
                modalities,
                thinking,
            });
        }
    }

    return out.length ? out : undefined;
}

function sanitizeServer(raw: RawServer, index: number): VllmServer | null {
    const baseUrlRaw =
        typeof raw.baseUrl === "string"
            ? raw.baseUrl
            : typeof raw.base_url === "string"
                ? raw.base_url
                : "";
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    if (!baseUrl) return null;

    const idRaw = typeof raw.id === "string" ? raw.id.trim() : "";
    const id = idRaw || `server_${index + 1}`;

    const nameRaw = typeof raw.name === "string" ? raw.name.trim() : "";
    const name = nameRaw || id;

    const apiKeyRaw =
        typeof raw.apiKey === "string"
            ? raw.apiKey
            : typeof raw.api_key === "string"
                ? raw.api_key
                : "";
    const apiKey = apiKeyRaw.trim() || undefined;

    const models = normalizeModels(raw.models ?? raw.modelIds ?? raw.model_ids);

    return { id, name, baseUrl, apiKey, models };
}

export function getServers(): VllmServer[] {
    const env = process.env.VLLM_SERVERS?.trim() ?? "";
    let servers: VllmServer[] = [];

    if (env) {
        try {
            const parsed = JSON.parse(env);
            if (Array.isArray(parsed)) {
                servers = parsed
                    .map((item, index) => sanitizeServer(item as RawServer, index))
                    .filter((item): item is VllmServer => Boolean(item));
            }
        } catch {
            servers = [];
        }
    }

    if (!servers.length) {
        const baseUrl = normalizeBaseUrl(process.env.VLLM_BASE_URL ?? "");
        if (baseUrl) {
            const name = (process.env.VLLM_SERVER_NAME ?? "").trim() || "Default";
            const apiKey = (process.env.VLLM_API_KEY ?? "").trim() || undefined;
            const models = normalizeModels(process.env.VLLM_MODELS);
            servers = [{ id: "default", name, baseUrl, apiKey, models }];
        }
    }

    const seen = new Set<string>();
    return servers.filter((server) => {
        if (seen.has(server.id)) return false;
        seen.add(server.id);
        return true;
    });
}

export function getServerById(id: string): VllmServer | null {
    if (!id) return null;
    return getServers().find((server) => server.id === id) ?? null;
}

export function getPublicServers(): Array<Omit<VllmServer, "apiKey">> {
    return getServers().map(({ apiKey: _apiKey, ...rest }) => rest);
}
