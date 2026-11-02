import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { memo, useMemo } from "react";
import { api } from "../api.ts";

/**
 * CommonMark 对中文加粗有个已知问题：「**当前目录：**里面」这种写法，结尾的 ** 前是全角标点、后是汉字，
 * 不算右侧定界符，整段不会加粗。Claude 的中文回复里很常见，这里加一条宽松的 **…** 规则优先匹配。
 */
const md = new Marked({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: "cjkStrong",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("**");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): Tokens.Strong | undefined {
        const m = /^\*\*(?!\s)([^\n]*?\S)\*\*(?!\*)/.exec(src);
        if (!m) return undefined;
        return { type: "strong", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
      },
    },
  ],
});

/** 相对路径按 Markdown 文件所在目录解析（. 和 .. 都处理），以项目根为界。 */
function resolvePath(dir: string, src: string): string {
  const parts = (src.startsWith("/") ? [] : dir.split("/").filter(Boolean)).concat(src.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * 渲染 Markdown（聊天气泡和文件编辑器的预览共用）。
 * 传了 imageBase 时，相对路径的图片按项目里的文件读取（http / data 开头的不动）。
 */
export const Markdown = memo(function Markdown(props: { text: string; className?: string; imageBase?: { projectId: string; dir: string } }) {
  const { text, imageBase } = props;
  const html = useMemo(() => {
    const clean = DOMPurify.sanitize(md.parse(text, { async: false }));
    if (!imageBase) return clean;
    const doc = new DOMParser().parseFromString(clean, "text/html");
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) continue;
      img.setAttribute("src", api.rawUrl(imageBase.projectId, resolvePath(imageBase.dir, decodeURI(src.split(/[?#]/)[0]!))));
    }
    return doc.body.innerHTML;
  }, [text, imageBase?.projectId, imageBase?.dir]);
  return <div className={props.className ?? "markdown text-[15px]"} dangerouslySetInnerHTML={{ __html: html }} />;
});

