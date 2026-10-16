import {describe,test,expect} from "bun:test";
import {mkdtemp,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {LocalVault} from "../../src/vault-local.js";
import {SearchIndex} from "../../src/search.js";
import {VaultRegistry} from "../../src/vault-registry.js";
import {registerTools} from "../../src/tools.js";
import {writeFileMetadata} from "../../lib/livesync-commonlib/src/managers/EntryManager/MetadataWrite.ts";

describe("atomic create_note",()=>{
 test("only the winning MCP create reaches the durable RAG change hook", async () => {
     const dir = await mkdtemp(join(tmpdir(), "create-note-rag-"));
     try {
         const vault = new LocalVault(dir);
         const index = new SearchIndex();
         const changed: Array<{path: string; content: string | null}> = [];
         const registry = new VaultRegistry([{
             id: "personal", name: "Personal", backend: vault, searchIndex: index,
             onDocumentChange: async (path, content) => { changed.push({path, content}); },
         }]);
         const tools: any[] = [];
         registerTools({addTool: (tool: any) => tools.push(tool)} as any, registry, false, ["raw"]);
         const tool = tools.find(tool => tool.name === "create_note");
         expect(tool).toBeDefined();
         const results = await Promise.allSettled(["one", "two", "three"].map(content =>
             tool.execute({vault_id: "personal", path: "raw/winner.md", content})));
         expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
         const winner = await vault.readNote("raw/winner.md");
         expect(changed).toEqual([{path: "raw/winner.md", content: winner}]);
         expect(index.size).toBe(1);
     } finally {
         await rm(dir, {recursive: true, force: true});
     }
 });

 test("concurrent exclusive creates preserve one complete winner",async()=>{const dir=await mkdtemp(join(tmpdir(),"create-note-"));try{const vault=new LocalVault(dir);expect(typeof vault.createNote).toBe("function");const results=await Promise.all(["one","two","three"].map(text=>vault.createNote!("raw/a.md",text)));expect(results.filter(Boolean)).toHaveLength(1);expect(["one","two","three"]).toContain(await vault.readNote("raw/a.md"));expect(await vault.createNote!("raw/a.md","replacement")).toBe(false);}finally{await rm(dir,{recursive:true,force:true});}});
 test("new note cannot escape through an existing parent symlink",async()=>{const dir=await mkdtemp(join(tmpdir(),"create-note-")),outside=await mkdtemp(join(tmpdir(),"outside-note-"));try{const vault=new LocalVault(dir);expect(typeof vault.createNote).toBe("function");await symlink(outside,join(dir,"escape"));await expect(vault.createNote!("escape/new.md","bad")).rejects.toThrow("Path traversal");}finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});
 test("CouchDB create metadata never inherits a revision or forces overwrite",async()=>{expect(typeof writeFileMetadata).toBe("function");let stored:any={_id:"note-id",_rev:"1-human",path:"a.md",marker:"human"};const database={get:async()=>stored,put:async(doc:any,options:any)=>{if(stored && doc._rev!==stored._rev&&!options.force)throw Object.assign(Error("conflict"),{status:409});stored=doc;return {ok:true,id:doc._id,rev:"2-new"};}};await expect(writeFileMetadata(database,{_id:"note-id",path:"a.md",marker:"AI"},undefined,true)).rejects.toMatchObject({status:409});expect(stored.marker).toBe("human");});
 test("ordinary metadata updates still use current revision",async()=>{expect(typeof writeFileMetadata).toBe("function");let stored:any={_id:"id",_rev:"1-old"};const db={get:async()=>stored,put:async(doc:any)=>{stored=doc;return {ok:true,id:doc._id,rev:"2-new"};}};expect(await writeFileMetadata(db,{_id:"id",path:"a.md"})).toEqual({ok:true,id:"id",rev:"2-new"});expect(stored._rev).toBe("1-old");});
 test("MCP create respects read-only and scope and retains indexed human content",async()=>{const dir=await mkdtemp(join(tmpdir(),"create-note-"));try{const vault=new LocalVault(dir),index=new SearchIndex();const registry=new VaultRegistry([{id:"personal",name:"Personal",backend:vault,searchIndex:index}]);const tools:any[]=[];registerTools({addTool:(t:any)=>tools.push(t)} as any,registry,false,["raw"]);const tool=tools.find(t=>t.name==="create_note");expect(tool).toBeDefined();expect(await tool.execute({vault_id:"personal",path:"wiki/no.md",content:"bad"})).toContain("denied");expect(await vault.readNote("wiki/no.md")).toBeNull();await tool.execute({vault_id:"personal",path:"raw/a.md",content:"human"});expect(await vault.readNote("raw/a.md")).toBe("human");await expect(tool.execute({vault_id:"personal",path:"raw/a.md",content:"AI"})).rejects.toThrow("already exists");expect(await vault.readNote("raw/a.md")).toBe("human");const readOnly:any[]=[];registerTools({addTool:(t:any)=>readOnly.push(t)} as any,registry,true);expect(readOnly.some(t=>t.name==="create_note")).toBe(false);}finally{await rm(dir,{recursive:true,force:true});}});
});
