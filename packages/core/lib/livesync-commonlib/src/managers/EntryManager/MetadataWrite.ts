import { isErrorOfMissingDoc } from "../../pouchdb/utils_couchdb.ts";

/** The create-only branch must never learn or reuse the current revision. */
export async function writeFileMetadata<T extends { _id: string; _rev?: string }>(
    database: {
        get(id: string): Promise<{ _rev: string }>;
        put(doc: T, options: { force: boolean }): Promise<{ ok: boolean; id: string; rev: string }>;
    },
    document: T,
    conflictBaseRev?: string,
    createOnly = false,
) {
    const doc = { ...document };
    if (createOnly) {
        delete doc._rev;
        return database.put(doc, { force: false });
    }
    if (conflictBaseRev) doc._rev = conflictBaseRev;
    else {
        try { doc._rev = (await database.get(doc._id))._rev; }
        catch (error) { if (!isErrorOfMissingDoc(error)) throw error; }
    }
    return database.put(doc, { force: true });
}
