export interface ChunkOptions {
    maxChars: number;
    overlapChars: number;
}

export interface MarkdownChunk {
    index: number;
    content: string;
}

export function chunkMarkdown(markdown: string, options: ChunkOptions): MarkdownChunk[] {
    const text = markdown.replace(/\r\n/g, "\n").trim();
    if (!text) return [{ index: 0, content: "" }];
    const max = Math.max(32, Math.floor(options.maxChars));
    const overlap = Math.max(0, Math.min(Math.floor(options.overlapChars), max - 1));
    const chunks: MarkdownChunk[] = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + max, text.length);
        if (end < text.length) {
            const paragraph = text.lastIndexOf("\n\n", end);
            const newline = text.lastIndexOf("\n", end);
            const boundary = Math.max(paragraph, newline);
            if (boundary > start + Math.floor(max / 2)) end = boundary + (boundary === paragraph ? 2 : 1);
        }
        chunks.push({ index: chunks.length, content: text.slice(start, end).trim() });
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlap);
    }
    return chunks;
}
