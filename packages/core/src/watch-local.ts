import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";

export interface LocalVaultWatcher {
    ready: Promise<void>;
    close(): Promise<void>;
}

export function watchMarkdownFiles(
    root: string,
    onChange: (notePath: string) => void | Promise<void>,
): LocalVaultWatcher {
    const watcher: FSWatcher = chokidar.watch(root, {
        ignoreInitial: true,
        ignored: (path) => path.includes("/.obsidian/") || path.endsWith("/.obsidian"),
    });
    const emit = (path: string) => {
        if (!path.endsWith(".md")) return;
        return onChange(relative(root, path).replace(/\\/g, "/"));
    };
    watcher.on("add", emit).on("change", emit).on("unlink", emit);

    return {
        ready: new Promise((resolve) => watcher.once("ready", resolve)),
        close: () => watcher.close(),
    };
}
