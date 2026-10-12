import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function InvitationActions({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useEffect(() => {
    const close = () => {
      if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  return (
    <>
      <button
        type="button"
        className="kebab-button"
        aria-label={label}
        aria-haspopup="menu"
        popoverTarget={menuId}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            top: Math.max(
              16,
              Math.min(rect.bottom + 6, window.innerHeight - 240),
            ),
            left: Math.max(
              16,
              Math.min(rect.right - 240, window.innerWidth - 256),
            ),
          });
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      <div
        id={menuId}
        ref={menu}
        popover="auto"
        role="menu"
        aria-label={label}
        className="invitation-actions-menu"
        style={{
          ...position,
          maxHeight: `calc(100dvh - ${position.top + 16}px)`,
        }}
        onToggle={(event) => {
          if (event.newState === "open")
            menu.current
              ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus();
        }}
        onKeyDown={(event) => {
          const buttons = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) || [],
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}
