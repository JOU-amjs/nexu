import { useEffect, useRef, useState } from "react";

const LOBSTER = "🦞";
const PREY = ["🐟", "🦐", "🦀", "🐚", "🪸"];
const EXPLODE_PARTICLES = ["✨", "💥", "🔥", "⭐", "💫"];

const MIN_LOBSTER_SIZE = 28;
const MAX_LOBSTER_SIZE = 80;
const SIZE_PER_EAT = 6;
const PREY_LIFETIME_MS = 3000;
const MAX_PREY = 10;

type PreyItem = {
  el: HTMLSpanElement;
  x: number;
  y: number;
  alive: boolean;
  wobbleOffset: number;
  wobbleSpeed: number;
  baseY: number;
  spawnedAt: number;
};

function isOverText(x: number, y: number): boolean {
  const elements = document.elementsFromPoint(x, y);

  for (const element of elements) {
    const htmlElement = element as HTMLElement;
    if (htmlElement.dataset?.cursorLayer) continue;

    const tag = htmlElement.tagName;
    if (
      tag === "A" ||
      tag === "BUTTON" ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    ) {
      return true;
    }

    const display = getComputedStyle(htmlElement).display;
    if (display === "inline" || display === "inline-block") {
      const text = htmlElement.textContent?.trim();
      if (text && text.length > 0 && htmlElement.children.length === 0) {
        return true;
      }
    }

    if (
      tag === "H1" ||
      tag === "H2" ||
      tag === "H3" ||
      tag === "H4" ||
      tag === "P" ||
      tag === "SPAN" ||
      tag === "LI" ||
      tag === "LABEL" ||
      tag === "TH" ||
      tag === "TD"
    ) {
      const rect = htmlElement.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return true;
      }
    }
  }

  return false;
}

export default function LobsterCursorEffect() {
  const [enabled, setEnabled] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const pointerQuery = window.matchMedia("(pointer: fine)");
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const update = () => {
      setEnabled(pointerQuery.matches && !motionQuery.matches);
    };

    update();
    pointerQuery.addEventListener("change", update);
    motionQuery.addEventListener("change", update);

    return () => {
      pointerQuery.removeEventListener("change", update);
      motionQuery.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const lobsterPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const lobsterVel = { x: 0, y: 0 };
    const preyList: PreyItem[] = [];

    let spawnThrottle = 0;
    let lobsterSize = MIN_LOBSTER_SIZE;

    const lobster = document.createElement("div");
    lobster.textContent = LOBSTER;
    lobster.dataset.cursorLayer = "1";
    lobster.style.cssText = `
      position: fixed;
      font-size: ${lobsterSize}px;
      pointer-events: none;
      z-index: 10000;
      transition: none;
      will-change: transform, left, top;
    `;
    container.appendChild(lobster);

    const explodeLobster = () => {
      const centerX = lobsterPos.x;
      const centerY = lobsterPos.y;

      for (let i = 0; i < 8; i++) {
        const particle = document.createElement("span");
        particle.textContent =
          EXPLODE_PARTICLES[
            Math.floor(Math.random() * EXPLODE_PARTICLES.length)
          ];
        particle.dataset.cursorLayer = "1";
        const angle = (Math.PI * 2 * i) / 8;

        particle.style.cssText = `
          position: fixed;
          left: ${centerX}px;
          top: ${centerY}px;
          font-size: ${16 + Math.random() * 12}px;
          pointer-events: none;
          z-index: 10001;
          transform: translate(-50%, -50%) scale(1);
          opacity: 1;
          transition: all 0.5s cubic-bezier(0.25, 1, 0.5, 1);
        `;

        container.appendChild(particle);
        const distance = 50 + Math.random() * 40;
        requestAnimationFrame(() => {
          particle.style.opacity = "0";
          particle.style.transform = `translate(${Math.cos(angle) * distance - 8}px, ${Math.sin(angle) * distance - 8}px) scale(0.3) rotate(${Math.random() * 360}deg)`;
        });
        setTimeout(() => particle.remove(), 520);
      }

      lobsterSize = MIN_LOBSTER_SIZE;
      lobster.style.fontSize = `${lobsterSize}px`;
      lobster.style.opacity = "0";
      setTimeout(() => {
        lobster.style.opacity = "1";
      }, 300);
    };

    const spawnPrey = (x: number, y: number) => {
      if (preyList.filter((item) => item.alive).length >= MAX_PREY) return;

      const spread = 80 + Math.random() * 100;
      const angle = Math.random() * Math.PI * 2;
      let preyX = x + Math.cos(angle) * spread;
      let preyY = y + Math.sin(angle) * spread;

      preyX = Math.max(20, Math.min(window.innerWidth - 20, preyX));
      preyY = Math.max(20, Math.min(window.innerHeight - 20, preyY));

      if (isOverText(preyX, preyY)) return;

      const prey = document.createElement("span");
      prey.textContent = PREY[Math.floor(Math.random() * PREY.length)];
      prey.dataset.cursorLayer = "1";
      prey.style.cssText = `
        position: fixed;
        left: ${preyX}px;
        top: ${preyY}px;
        font-size: ${14 + Math.random() * 6}px;
        pointer-events: none;
        z-index: 9998;
        transform: translate(-50%, -50%) scale(0);
        transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.6s;
        opacity: 1;
        will-change: transform, left, top;
      `;

      container.appendChild(prey);
      requestAnimationFrame(() => {
        prey.style.transform = "translate(-50%, -50%) scale(1)";
      });

      preyList.push({
        el: prey,
        x: preyX,
        y: preyY,
        alive: true,
        wobbleOffset: Math.random() * Math.PI * 2,
        wobbleSpeed: 1.5 + Math.random() * 1.5,
        baseY: preyY,
        spawnedAt: Date.now(),
      });
    };

    const fadePrey = (item: PreyItem) => {
      item.alive = false;
      item.el.style.transform = "translate(-50%, -50%) scale(0.3)";
      item.el.style.opacity = "0";
      setTimeout(() => item.el.remove(), 620);
    };

    const eatPrey = (item: PreyItem) => {
      item.alive = false;
      item.el.style.transform = "translate(-50%, -50%) scale(0)";
      item.el.style.opacity = "0";
      setTimeout(() => item.el.remove(), 320);

      lobsterSize = Math.min(
        lobsterSize + SIZE_PER_EAT,
        MAX_LOBSTER_SIZE + SIZE_PER_EAT,
      );
      if (lobsterSize > MAX_LOBSTER_SIZE) {
        explodeLobster();
      } else {
        lobster.style.fontSize = `${lobsterSize}px`;
      }
    };

    const handleMove = (event: MouseEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;

      const now = Date.now();
      if (now - spawnThrottle > 400) {
        spawnThrottle = now;
        spawnPrey(event.clientX, event.clientY);
      }
    };

    window.addEventListener("mousemove", handleMove);

    let raf = 0;
    let t = 0;
    const animate = () => {
      t += 0.016;
      const now = Date.now();

      const stiffness = 0.06;
      const damping = 0.78;

      lobsterVel.x =
        (lobsterVel.x + (mouse.x - lobsterPos.x) * stiffness) * damping;
      lobsterVel.y =
        (lobsterVel.y + (mouse.y - lobsterPos.y) * stiffness) * damping;

      lobsterPos.x += lobsterVel.x;
      lobsterPos.y += lobsterVel.y;

      const speed = Math.sqrt(lobsterVel.x ** 2 + lobsterVel.y ** 2);
      const angle = Math.atan2(lobsterVel.y, lobsterVel.x) * (180 / Math.PI);
      const rotation = speed > 0.5 ? angle + 90 : 0;
      const growthRatio =
        (lobsterSize - MIN_LOBSTER_SIZE) /
        (MAX_LOBSTER_SIZE - MIN_LOBSTER_SIZE);
      const wobble = growthRatio > 0.7 ? Math.sin(t * 12) * 3 * growthRatio : 0;

      lobster.style.left = `${lobsterPos.x}px`;
      lobster.style.top = `${lobsterPos.y}px`;
      lobster.style.transform = `translate(-50%, -50%) rotate(${rotation + wobble}deg)`;

      const eatRadius = 25 + lobsterSize * 0.3;

      for (let i = preyList.length - 1; i >= 0; i--) {
        const item = preyList[i];

        if (!item.alive) {
          if (!item.el.parentNode) preyList.splice(i, 1);
          continue;
        }

        if (now - item.spawnedAt > PREY_LIFETIME_MS) {
          fadePrey(item);
          continue;
        }

        const age = now - item.spawnedAt;
        const fadeStart = PREY_LIFETIME_MS * 0.4;
        if (age > fadeStart) {
          const fadeProgress =
            (age - fadeStart) / (PREY_LIFETIME_MS - fadeStart);
          item.el.style.opacity = `${1 - fadeProgress}`;
        }

        item.el.style.top = `${item.baseY + Math.sin(t * item.wobbleSpeed + item.wobbleOffset) * 4}px`;

        const dx = lobsterPos.x - item.x;
        const dy =
          lobsterPos.y -
          (item.baseY + Math.sin(t * item.wobbleSpeed + item.wobbleOffset) * 4);
        if (Math.sqrt(dx * dx + dy * dy) < eatRadius) {
          eatPrey(item);
        }
      }

      raf = window.requestAnimationFrame(animate);
    };

    raf = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.cancelAnimationFrame(raf);
      container.innerHTML = "";
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="fixed inset-0 z-[70] pointer-events-none"
    />
  );
}
