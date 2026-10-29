import type { ProjectSuggestion } from "@projdeck/shared";
import { FolderInputIcon, FolderPlusIcon } from "lucide-react";
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../api.ts";

export function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<"new" | "import">("new");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [git, setGit] = useState(true);
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    api.suggestions().then(setSuggestions, () => {});
  }, [open]);

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

            <TabsContent value="import" className="flex min-w-0 flex-col gap-4 pt-2">
              <FieldGroup>
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="project-path">文件夹路径</FieldLabel>
                  <Input
                    id="project-path"
                    placeholder="~/Repositories/wx-monitor"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={!!error}
                  />
                  {error && <FieldError>{error}</FieldError>}
                </Field>
              </FieldGroup>
              {suggestions.length > 0 && (
                <div className="flex min-w-0 flex-col gap-2">
                  <p className="text-xs text-muted-foreground">herdr 中正在使用的目录，点击即可导入：</p>
                  <ItemGroup className="max-h-64 gap-1.5 overflow-y-auto">
                    {suggestions.map((s) => (
                      <Item key={s.path} variant="outline" size="sm" asChild>
                        <button type="button" disabled={busy} onClick={() => void run(() => api.createProject({ path: s.path }))}>
                          <ItemContent className="min-w-0">
                            <ItemTitle>{s.name}</ItemTitle>
                            <ItemDescription className="truncate font-mono text-xs">{s.path}</ItemDescription>
                          </ItemContent>
                          <ItemActions className="text-xs text-muted-foreground">{s.sessionCount} 个会话</ItemActions>
                        </button>
                      </Item>
                    ))}
                  </ItemGroup>
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
