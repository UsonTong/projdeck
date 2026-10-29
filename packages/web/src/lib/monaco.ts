/**
 * VS Code 的编辑器组件（Monaco），用于在文件管理器里做简单修改。只在打开编辑器时才加载（见 CodeEditor 的 lazy import）。
 * 各语言的语法高亮按需加载；TS / JSON / CSS / HTML 另有语言服务（补全、语法检查），在后台 worker 里运行。
 */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import type { TerminalTheme } from "@projdeck/shared";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// 网页里没有项目的依赖和 tsconfig，类型检查只会满屏报「找不到模块」，只保留语法检查
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

/** #rrggbb 的亮度，用来判断主题是深色还是浅色。 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const strip = (hex: string) => hex.replace("#", "").slice(0, 6);

/** 用 Ghostty 的配色生成编辑器主题：背景、前景、选区、光标与终端一致，语法颜色取 16 色调色板。 */
export function applyEditorTheme(t: TerminalTheme): void {
  const p = t.palette;
  const dark = luminance(t.background) < 0.5;
  monaco.editor.defineTheme("projdeck", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: strip(p[8] ?? "#7f848e"), fontStyle: "italic" },
      { token: "keyword", foreground: strip(p[5] ?? "#c678dd") },
      { token: "string", foreground: strip(p[2] ?? "#98c379") },
      { token: "number", foreground: strip(p[3] ?? "#d19a66") },
      { token: "type", foreground: strip(p[6] ?? "#56b6c2") },
      { token: "function", foreground: strip(p[4] ?? "#61afef") },
      { token: "variable", foreground: strip(t.foreground) },
      { token: "tag", foreground: strip(p[1] ?? "#e06c75") },
      { token: "attribute.name", foreground: strip(p[3] ?? "#d19a66") },
      { token: "delimiter", foreground: strip(p[7] ?? t.foreground) },
      { token: "regexp", foreground: strip(p[6] ?? "#56b6c2") },
    ],
    colors: {
      "editor.background": t.background,
      "editor.foreground": t.foreground,
      "editorCursor.foreground": t.cursor,
      "editor.selectionBackground": t.selectionBackground,
      "editor.lineHighlightBackground": `${t.foreground}0d`,
      "editorLineNumber.foreground": `${t.foreground}55`,
      "editorLineNumber.activeForeground": `${t.foreground}cc`,
      "editorGutter.background": t.background,
      "minimap.background": t.background,
      "editorWidget.background": t.background,
      "scrollbarSlider.background": `${t.foreground}22`,
      "scrollbarSlider.hoverBackground": `${t.foreground}33`,
    },
  });
  monaco.editor.setTheme("projdeck");
}

export { monaco };
