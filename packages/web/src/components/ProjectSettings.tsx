import type { AgentKind, ProjectView } from "@projdeck/shared";
import { ArchiveIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { confirmDialog } from "./Confirm.tsx";

const fail = (err: unknown) => toast.error((err as Error).message);

/** 项目设置：用对话框代替下拉菜单。 */
export function ProjectSettingsDialog(props: { project: ProjectView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { project } = props;

  const archive = async () => {
    const ok = await confirmDialog({
      title: `归档项目「${project.name}」？`,
      description: "项目会移到「归档」里，herdr 中正在运行的会话不受影响。",
      action: "归档",
    });
    if (!ok) return;
    await api.updateProject(project.id, { archived: true }).then(() => props.onOpenChange(false), fail);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `取消登记「${project.name}」？`,
      description: "只是从 projdeck 移除，不会删除文件夹，也不会关闭 herdr 中的会话。",
      action: "取消登记",
      destructive: true,
    });
    if (!ok) return;
    await api.removeProject(project.id).then(() => props.onOpenChange(false), fail);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{project.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{project.path}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>默认 agent</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={project.defaultAgent}
              onValueChange={(v) => v && void api.updateProject(project.id, { defaultAgent: v as AgentKind }).catch(fail)}
              className="w-full"
            >
              <ToggleGroupItem value="claude" className="flex-1 gap-2">
                <AgentIcon kind="claude" size="xs" />
                Claude
              </ToggleGroupItem>
              <ToggleGroupItem value="codex" className="flex-1 gap-2">
                <AgentIcon kind="codex" size="xs" />
                Codex
              </ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>项目标题旁新开会话的图标会把默认 agent 放在前面。</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id={`notify-${project.id}`}
              checked={project.notify !== false}
              onCheckedChange={(v) => void api.updateProject(project.id, { notify: v === true }).catch(fail)}
            />
            <FieldLabel htmlFor={`notify-${project.id}`} className="font-normal">
              推送这个项目的完成 / 需处理通知
            </FieldLabel>
          </Field>
        </FieldGroup>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => void archive()}>
            <ArchiveIcon data-icon="inline-start" />
            归档项目
          </Button>
          <Button variant="destructive" onClick={() => void remove()}>
            <Trash2Icon data-icon="inline-start" />
            取消登记
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
