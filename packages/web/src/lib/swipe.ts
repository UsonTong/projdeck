import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

/** 当前打开的那一行的关闭函数：同一时间只打开一行。 */
let closeOpenRow: (() => void) | null = null;

/** 触屏设备（没有鼠标悬停）。 */
export const isTouchDevice = () => matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * 触屏上左滑露出一行的操作按钮（类似 iOS 邮件）。只响应手指；竖向滑动交给浏览器滚动列表
 * （元素需要 touch-action: pan-y）。滑过一半松手就停在打开状态，点这一行或右滑关闭。
 */
export function useSwipeReveal(width: number) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; base: number; dir: "h" | "v" | null } | null>(null);
  /** 刚滑动过：松手后浏览器补发的 click 不能当成点击。 */
  const swiped = useRef(false);

  const close = useCallback(() => setOffset(0), []);
  useEffect(
    () => () => {
      if (closeOpenRow === close) closeOpenRow = null;
    },
    [close],
  );

  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.dir !== "h") return;
    setDragging(false);
    setOffset((o) => {
      const open = o < -width / 2;
      if (open) closeOpenRow = close;
      else if (closeOpenRow === close) closeOpenRow = null;
      return open ? -width : 0;
    });
  };

  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType !== "touch") return;
      gesture.current = { x: e.clientX, y: e.clientY, base: offset, dir: null };
      swiped.current = false;
    },
    onPointerMove(e: PointerEvent) {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.dir) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          g.dir = "h";
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
          setDragging(true);
        } else if (Math.abs(dy) > 8) g.dir = "v";
      }
      if (g.dir === "h") {
        swiped.current = true;
        setOffset(Math.max(-width, Math.min(0, g.base + dx)));
      }
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture(e: MouseEvent) {
      if (swiped.current || offset !== 0) {
        e.stopPropagation();
        e.preventDefault();
        swiped.current = false;
        if (offset !== 0) setOffset(0);
      }
    },
  };

  return { offset, dragging, handlers, close };
}

/**
 * 横向滑动切换（会话页标题栏左右滑到上一个 / 下一个会话）。返回跟手的位移，松手时超过阈值就切换。
 * 只响应手指；竖向的移动不处理。
 */
export function useSwipeNav(onPrev: (() => void) | null, onNext: (() => void) | null, threshold = 60) {
  const [dx, setDx] = useState(0);
  const gesture = useRef<{ x: number; y: number; dir: "h" | "v" | null } | null>(null);

  const end = (e: PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.dir !== "h") return;
    const d = e.clientX - g.x;
    setDx(0);
    if (d > threshold) onPrev?.();
    else if (d < -threshold) onNext?.();
  };

  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === "touch") gesture.current = { x: e.clientX, y: e.clientY, dir: null };
    },
    onPointerMove(e: PointerEvent) {
      const g = gesture.current;
      if (!g) return;
      const d = e.clientX - g.x;
      if (!g.dir) {
        if (Math.abs(d) > 8 && Math.abs(d) > Math.abs(e.clientY - g.y)) {
          g.dir = "h";
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } else if (Math.abs(e.clientY - g.y) > 8) g.dir = "v";
      }
      // 没有上一个 / 下一个时只给一点阻尼，提示到头了
      if (g.dir === "h") setDx((d > 0 ? onPrev : onNext) ? d : d / 4);
    },
    onPointerUp: end,
    onPointerCancel() {
      gesture.current = null;
      setDx(0);
    },
  };

  return { dx, handlers };
}
