import type { FolderListing, ProjectSuggestion } from "@projdeck/shared";
import { CornerLeftUpIcon, FolderIcon, FolderInputIcon, FolderPlusIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../api.ts";

export function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<"new" | "import">("new");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [git, setGit] = useState(true);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    api.suggestions().then(setSuggestions, () => {});
  }, [open]);

  // 边输入边浏览：列出路径所在文件夹的子文件夹（路径还不完整时，列出最近一级存在的上级）
  useEffect(() => {
    if (!open || tab !== "import") return;
    const t = setTimeout(() => api.folders(path.trim() || "~").then(setListing, () => {}), 150);
    return () => clearTimeout(t);
  }, [open, tab, path]);

  const child = (name: string) => (listing ? `${listing.display}/${name}` : name);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setName("");
      setPath("");
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => (tab === "new" ? api.createProject({ name: name.trim(), git }) : api.createProject({ path: path.trim() })));
  };

  const canSubmit = !busy && (tab === "new" ? name.trim() !== "" : path.trim() !== "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>添加项目</DialogTitle>
            <DialogDescription>一个项目对应一个文件夹，在里面开的 agent 会自动归到这个项目。</DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(v) => setTab(v as "new" | "import")}>
            <TabsList className="w-full">
              <TabsTrigger value="new">
                <FolderPlusIcon />
                新建
              </TabsTrigger>
              <TabsTrigger value="import">
                <FolderInputIcon />
                导入已有文件夹
              </TabsTrigger>
            </TabsList>

            <TabsContent value="new" className="pt-2">
              <FieldGroup>
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="project-name">项目名</FieldLabel>
                  <Input id="project-name" placeholder="my-app" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
                  <FieldDescription>会在 ~/Projects 下创建同名文件夹。</FieldDescription>
                  {error && <FieldError>{error}</FieldError>}
                </Field>
                <Field orientation="horizontal">
                  <Checkbox id="project-git" checked={git} onCheckedChange={(v) => setGit(v === true)} />
                  <FieldLabel htmlFor="project-git" className="font-normal">
                    初始化 git 仓库（claude-hud 的 git 信息需要它）
                  </FieldLabel>
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="import" className="flex min-w-0 flex-col gap-3 pt-2">
              <FieldGroup>
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="project-path">文件夹路径</FieldLabel>
                  <Input
                    id="project-path"
                    placeholder="~/Repositories/voice-survey"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={!!error}
                  />
                  <FieldDescription>可以直接输入，也可以在下面一层层点进去选。确认路径无误后点「导入」。</FieldDescription>
                  {error && <FieldError>{error}</FieldError>}
                </Field>
              </FieldGroup>

              {/* 文件夹浏览：点一下进入（填入路径），不会直接导入 */}
              {listing && (
                <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border">
                  <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="上一级"
                      disabled={!listing.parent}
                      onClick={() => listing.parent && setPath(listing.display.replace(/\/[^/]+$/, "") || "~")}
                    >
                      <CornerLeftUpIcon />
                    </Button>
                    <span className="truncate font-mono text-xs text-muted-foreground">{listing.display}</span>
                  </div>
                  <div className="flex max-h-56 flex-col overflow-y-auto p-1">
                    {listing.dirs.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">没有子文件夹</p>}
                    {listing.dirs.map((d) => (
                      <button
                        key={d.path}
                        type="button"
                        onClick={() => setPath(child(d.name))}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                      >
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        {d.git && <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="git 仓库" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {suggestions.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground">会话启动时所在的目录（点一下填入路径）：</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <Button key={s.path} type="button" variant="outline" size="xs" title={s.path} onClick={() => setPath(s.path)}>
                        {s.name}
                        <span className="text-muted-foreground">{s.sessionCount}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Spinner data-icon="inline-start" />}
              {tab === "new" ? "创建" : "导入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
