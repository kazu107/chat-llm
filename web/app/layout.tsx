import "./globals.css";

export const metadata = {
    title: "LFM2.5-1.2B-JP Chat (vLLM)",
    description: "Local chat UI backed by vLLM OpenAI-compatible server"
};

export default function RootLayout({
                                       children
                                   }: {
    children: React.ReactNode;
}) {
    return (
        <html lang="ja">
        <body>{children}</body>
        </html>
    );
}
