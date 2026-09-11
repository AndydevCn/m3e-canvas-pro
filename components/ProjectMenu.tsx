"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Palette } from "@/lib/tokens";
import { t, useLang } from "@/lib/i18n";
import { Icon } from "./M3Node";
import type { ProjectSnapshot } from "@/lib/persist";

const EASE = [0.2, 0, 0, 1] as const;

/** The design being edited, and the way to another one. A canvas that only ever
 *  held one design forced the author to export before starting something new;
 *  here every design stays a click away. */
export function ProjectChip({
  p,
  snapshot,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  getThumb,
}: {
  p: Palette;
  snapshot: ProjectSnapshot;
  onOpen?: (id: string) => void;
  onCreate?: () => void;
  onRename?: () => void;
  onDelete?: (id: string) => void;
  getThumb?: (id: string) => Promise<string | null>;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const askedFor = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* pictures are read only for the designs the author actually looks at */
  useEffect(() => {
    if (!open || !getThumb) return;
    let alive = true;
    void (async () => {
      for (const project of snapshot.projects) {
        if (askedFor.current.has(project.id)) continue;
        askedFor.current.add(project.id);
        const url = await getThumb(project.id);
        if (alive && url) setThumbs((prev) => ({ ...prev, [project.id]: url }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, snapshot.projects, getThumb]);

  const name = snapshot.name || t("untitled", lang);
  const row = (label: string, icon: string, onClick: () => void, danger = false) => (
    <button
      key={label}
      className="m3-press"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 44,
        padding: "0 12px",
        border: "none",
        borderRadius: 12,
        background: "transparent",
        color: danger ? p.error : p.onSurface,
        font: "inherit",
        fontSize: 14,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <Icon name={icon} size={20} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );

  return (
    <div ref={ref} style={{ position: "relative", pointerEvents: "auto" }}>
      <button
        className="m3-press"
        onClick={() => setOpen((o) => !o)}
        title={t("switchProject", lang)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 40,
          padding: "0 12px",
          borderRadius: 20,
          border: "none",
          background: p.surfaceContainerLow,
          color: p.onSurface,
          font: "inherit",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          maxWidth: 220,
        }}
      >
        <Icon name="folder" size={18} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <Icon name={open ? "arrow_drop_up" : "arrow_drop_down"} size={20} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.16, ease: EASE }}
            style={{
              position: "absolute",
              top: 48,
              left: 0,
              width: 280,
              maxHeight: "60vh",
              overflowY: "auto",
              padding: 6,
              borderRadius: 18,
              background: p.surfaceContainerLow,
              boxShadow: "0 6px 20px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.04)",
              transformOrigin: "top left",
              zIndex: 60,
            }}
          >
            {snapshot.projects.map((project) => {
              const current = project.id === snapshot.id;
              const thumb = thumbs[project.id];
              return (
                <button
                  key={project.id}
                  className="m3-press"
                  onClick={() => {
                    setOpen(false);
                    if (!current) onOpen?.(project.id);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    minHeight: 52,
                    padding: "6px 10px",
                    border: "none",
                    borderRadius: 12,
                    background: current ? p.surfaceContainerHighest : "transparent",
                    color: p.onSurface,
                    font: "inherit",
                    fontSize: 14,
                    textAlign: "left",
                    cursor: current ? "default" : "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 44,
                      height: 44,
                      flex: "0 0 auto",
                      borderRadius: 10,
                      overflow: "hidden",
                      background: p.surfaceContainerHigh,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {thumb ? (
                      <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <Icon name="draw" size={20} />
                    )}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: current ? 700 : 500,
                      }}
                    >
                      {project.name || t("untitled", lang)}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: p.onSurfaceVariant }}>
                      {new Date(project.updatedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                  {current && <Icon name="check" size={20} />}
                </button>
              );
            })}

            <div style={{ height: 1, background: p.outlineVariant, opacity: 0.5, margin: "6px 4px" }} />
            {onCreate && row(t("newProject", lang), "add", onCreate)}
            {onRename && row(t("renameProject", lang), "edit", onRename)}
            {onDelete && snapshot.id && row(t("deleteProject", lang), "delete", () => onDelete(snapshot.id as string), true)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
