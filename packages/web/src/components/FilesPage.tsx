import { ArrowLeftIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { useLive, useWide } from "../live.ts";
import { openFiles, openSession } from "../router.ts";
import { FileBrowser } from "./FileBrowser.tsx";

/** 项目文件管理器页面（路由 #/f/<projectId>/<路径>）。 */
export function FilesPage({ projectId, path }: { projectId: string; path: string }) {
  const { overview } = useLive();
  const wide = useWide();
  const project = overview?.projects.find((p) => p.id === projectId);
  // 手机上打开编辑器时收起这条标题栏，编辑器自己的标题栏已经有返回和文件名
  const [editing, setEditing] = useState(false);
  const headerHidden = editing && !wide;

  if (overview && !project) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>项目不存在</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => openSession(null)}>返回总览</Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${headerHidden ? "pt-[env(safe-area-inset-top)]" : ""}`}>
      {!headerHidden && (
        <header className="flex items-center gap-2 border-b px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
          {!wide && (
            <Button variant="ghost" size="icon" aria-label="返回" onClick={() => openSession(null)}>
              <ArrowLeftIcon />
            </Button>
          )}
          <span className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-status-working ring-1 ring-border">
            <FolderOpenIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{project?.name ?? projectId} · 文件</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{project?.path}</div>
          </div>
        </header>
      )}
      {project && (
        <FileBrowser
          projectId={projectId}
          projectName={project.name}
          projectPath={project.path}
          path={path}
          onNavigate={(p) => openFiles(projectId, p)}
          projects={overview?.projects.filter((p) => !p.archived)}
          onOpenProject={(id) => openFiles(id)}
          compact={!wide}
          onEditingChange={setEditing}
        />
      )}
    </div>
  );
}
