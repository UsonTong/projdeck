import { type RefObject, useLayoutEffect, useRef } from "react";

/*
 * 列表重新排序、前面的行增删时，其他行不要「啪」地跳到新位置，而是从原来的位置滑过去（FLIP）。
 * 给容器的直接子元素标上 data-flip="<稳定的 id>"，在渲染这个容器的组件里调用 useFlip(ref)。
 * 位置按「相对容器顶部」量，所以滚动不影响；上一次的动画没播完就先取消，量到真实的布局位置再接着动。
 * 新出现的行不在这里处理（给行加 motion-rise，挂载时自己淡入）。
 */
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export function useFlip(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      prev.current = new Map();
      return;
    }
    const kids = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.flip);
    for (const k of kids) for (const a of k.getAnimations()) if (a.id === "flip") a.cancel();
    const base = el.getBoundingClientRect().top;
    const next = new Map<string, number>();
    for (const k of kids) next.set(k.dataset.flip!, k.getBoundingClientRect().top - base);
    if (enabled && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const k of kids) {
        const id = k.dataset.flip!;
        const before = prev.current.get(id);
        const delta = before === undefined ? 0 : before - next.get(id)!;
        if (Math.abs(delta) < 1) continue;
        k.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 420, easing: EASE, id: "flip" });
      }
    }
    prev.current = next;
  });
}
