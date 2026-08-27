"use client";

import { useEffect, useRef } from "react";

type InteractiveDifferenceCursorProps = {
  interactiveSelector?: string;
};

const defaultInteractiveSelector = "a, button, input, select, textarea, [role='button']";

export function InteractiveDifferenceCursor({
  interactiveSelector = defaultInteractiveSelector
}: InteractiveDifferenceCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cursor = cursorRef.current;
    const scope = cursor?.parentElement;
    if (!cursor || !scope) return;
    const cursorElement = cursor;

    const current = { x: -100, y: -100 };
    const target = { x: -100, y: -100 };
    const velocity = { x: 0, y: 0 };
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let active = false;
    let frameId = 0;
    let lastFrameTime = performance.now();

    function moveCursor(event: PointerEvent, immediate = false) {
      target.x = event.clientX;
      target.y = event.clientY;
      if (immediate) {
        current.x = target.x;
        current.y = target.y;
        velocity.x = 0;
        velocity.y = 0;
        cursorElement.style.transform = `translate3d(${current.x - 16}px, ${current.y - 16}px, 0)`;
      }
    }

    function syncInteractiveState(event: PointerEvent) {
      const element = event.target instanceof Element ? event.target : null;
      cursorElement.classList.toggle("is-interactive", !!element?.closest(interactiveSelector));
    }

    function showCursor(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;
      active = true;
      moveCursor(event, true);
      syncInteractiveState(event);
      cursorElement.classList.add("is-visible");
    }

    function updateCursor(event: PointerEvent) {
      if (event.pointerType !== "mouse") return;
      if (!active) {
        showCursor(event);
        return;
      }
      moveCursor(event);
      syncInteractiveState(event);
    }

    function hideCursor() {
      active = false;
      cursorElement.classList.remove("is-visible", "is-interactive");
    }

    function animate(frameTime: number) {
      const delta = Math.min(32, frameTime - lastFrameTime) / 16.67;
      lastFrameTime = frameTime;

      if (motionQuery.matches) {
        current.x = target.x;
        current.y = target.y;
        velocity.x = 0;
        velocity.y = 0;
      } else {
        const stiffness = 0.24;
        const damping = 0.62;
        velocity.x += (target.x - current.x) * stiffness * delta;
        velocity.y += (target.y - current.y) * stiffness * delta;
        velocity.x *= Math.pow(damping, delta);
        velocity.y *= Math.pow(damping, delta);
        current.x += velocity.x * delta;
        current.y += velocity.y * delta;
      }

      cursorElement.style.transform = `translate3d(${current.x - 16}px, ${current.y - 16}px, 0)`;
      frameId = window.requestAnimationFrame(animate);
    }

    scope.addEventListener("pointerenter", showCursor);
    scope.addEventListener("pointermove", updateCursor);
    scope.addEventListener("pointerleave", hideCursor);
    frameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frameId);
      scope.removeEventListener("pointerenter", showCursor);
      scope.removeEventListener("pointermove", updateCursor);
      scope.removeEventListener("pointerleave", hideCursor);
    };
  }, [interactiveSelector]);

  return (
    <div ref={cursorRef} className="interactive-difference-cursor" aria-hidden="true">
      <span className="interactive-difference-cursor-core" />
    </div>
  );
}
