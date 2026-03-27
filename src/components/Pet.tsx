import { motion, useAnimationControls, AnimatePresence } from "framer-motion";
import { useEffect, useCallback, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/lib/store";
import { quitApp } from "@/lib/commands";
import type { PetAppearance, PetState } from "@/lib/types";

import petIdle from "@/assets/pet/idle.png";
import petThinking from "@/assets/pet/thinking.png";
import petTalking from "@/assets/pet/talking.png";
import petHappy from "@/assets/pet/happy.png";
import petError from "@/assets/pet/error.png";

const BUILTIN_IMAGES: Record<PetState, string> = {
  idle: petIdle,
  thinking: petThinking,
  talking: petTalking,
  happy: petHappy,
  error: petError,
};

const BODY_COLORS: Record<PetState, string> = {
  idle: "#64b4ff",
  thinking: "#b4a0ff",
  talking: "#64dcb4",
  happy: "#ffc864",
  error: "#ff6b6b",
};

const BODY_GLOW: Record<PetState, string> = {
  idle: "rgba(100,180,255,0.3)",
  thinking: "rgba(180,160,255,0.4)",
  talking: "rgba(100,220,180,0.3)",
  happy: "rgba(255,200,100,0.4)",
  error: "rgba(255,107,107,0.4)",
};

function appearancePath(
  appearance: PetAppearance | undefined,
  state: PetState
): string | undefined {
  if (!appearance) return undefined;
  const v = appearance[state];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function PetVectorGraphic({
  petState,
  size,
}: {
  petState: PetState;
  size: number;
}) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const color = BODY_COLORS[petState];
  const glow = BODY_GLOW[petState];

  return (
<svg
        width={s}
        height={s}
        viewBox={`0 0 ${s} ${s}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* shadow */}
        <ellipse
          cx={cx}
          cy={cy + 30}
          rx={28}
          ry={7}
          fill="rgba(0,0,0,0.1)"
        />

        {/* body glow */}
        <ellipse cx={cx} cy={cy} rx={38} ry={36} fill={glow}>
          <animate
            attributeName="rx"
            values="38;40;38"
            dur="3s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="ry"
            values="36;38;36"
            dur="3s"
            repeatCount="indefinite"
          />
        </ellipse>

        {/* body */}
        <rect
          x={cx - 38}
          y={cy - 36}
          width={76}
          height={72}
          rx={34}
          fill={color}
          stroke={color}
          strokeWidth={2}
          filter="url(#bodyShadow)"
        >
          <animate
            attributeName="y"
            values={`${cy - 36};${cy - 39};${cy - 36}`}
            dur="3s"
            repeatCount="indefinite"
          />
        </rect>

        {/* eyes */}
        {petState === "happy" ? (
          <>
            {/* happy closed eyes */}
            <path
              d={`M${cx - 16} ${cy - 8} Q${cx - 11} ${cy - 14} ${cx - 6} ${cy - 8}`}
              fill="none"
              stroke="#282840"
              strokeWidth={2.5}
              strokeLinecap="round"
            >
              <animate
                attributeName="d"
                values={`M${cx - 16} ${cy - 8} Q${cx - 11} ${cy - 14} ${cx - 6} ${cy - 8};M${cx - 16} ${cy - 11} Q${cx - 11} ${cy - 17} ${cx - 6} ${cy - 11};M${cx - 16} ${cy - 8} Q${cx - 11} ${cy - 14} ${cx - 6} ${cy - 8}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </path>
            <path
              d={`M${cx + 6} ${cy - 8} Q${cx + 11} ${cy - 14} ${cx + 16} ${cy - 8}`}
              fill="none"
              stroke="#282840"
              strokeWidth={2.5}
              strokeLinecap="round"
            >
              <animate
                attributeName="d"
                values={`M${cx + 6} ${cy - 8} Q${cx + 11} ${cy - 14} ${cx + 16} ${cy - 8};M${cx + 6} ${cy - 11} Q${cx + 11} ${cy - 17} ${cx + 16} ${cy - 11};M${cx + 6} ${cy - 8} Q${cx + 11} ${cy - 14} ${cx + 16} ${cy - 8}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </path>
          </>
        ) : petState === "thinking" ? (
          <>
            {/* looking-up eyes */}
            <ellipse cx={cx - 11} cy={cy - 10} rx={5} ry={5} fill="#282840" />
            <ellipse cx={cx + 11} cy={cy - 10} rx={5} ry={5} fill="#282840" />
            <circle cx={cx - 9} cy={cy - 12} r={2} fill="white" />
            <circle cx={cx + 13} cy={cy - 12} r={2} fill="white" />
          </>
        ) : (
          <>
            {/* normal eyes */}
            <ellipse cx={cx - 11} cy={cy - 6} rx={5} ry={6} fill="#282840">
              <animate
                attributeName="cy"
                values={`${cy - 6};${cy - 9};${cy - 6}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </ellipse>
            <ellipse cx={cx + 11} cy={cy - 6} rx={5} ry={6} fill="#282840">
              <animate
                attributeName="cy"
                values={`${cy - 6};${cy - 9};${cy - 6}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </ellipse>
            <circle cx={cx - 9} cy={cy - 5} r={2} fill="white">
              <animate
                attributeName="cy"
                values={`${cy - 5};${cy - 8};${cy - 5}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </circle>
            <circle cx={cx + 13} cy={cy - 5} r={2} fill="white">
              <animate
                attributeName="cy"
                values={`${cy - 5};${cy - 8};${cy - 5}`}
                dur="3s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        )}

        {/* mouth */}
        {petState === "talking" ? (
          <ellipse cx={cx} cy={cy + 12} rx={6} ry={4} fill="#282840">
            <animate
              attributeName="ry"
              values="4;6;4"
              dur="0.6s"
              repeatCount="indefinite"
            />
          </ellipse>
        ) : petState === "happy" ? (
          <path
            d={`M${cx - 10} ${cy + 10} Q${cx} ${cy + 20} ${cx + 10} ${cy + 10}`}
            fill="none"
            stroke="#282840"
            strokeWidth={2}
            strokeLinecap="round"
          />
        ) : (
          <path
            d={`M${cx - 6} ${cy + 10} Q${cx} ${cy + 16} ${cx + 6} ${cy + 10}`}
            fill="none"
            stroke="#282840"
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}

        {/* cheeks */}
        {(petState === "happy" || petState === "talking") && (
          <>
            <ellipse
              cx={cx - 26}
              cy={cy + 4}
              rx={7}
              ry={4}
              fill="rgba(255,150,150,0.5)"
            />
            <ellipse
              cx={cx + 26}
              cy={cy + 4}
              rx={7}
              ry={4}
              fill="rgba(255,150,150,0.5)"
            />
          </>
        )}

        {/* thinking dots */}
        {petState === "thinking" && (
          <>
            {[0, 1, 2].map((i) => (
              <circle
                key={i}
                cx={cx - 10 + i * 10}
                cy={cy + 26}
                r={3}
                fill="#7c6cdc"
              >
                <animate
                  attributeName="opacity"
                  values="0.3;1;0.3"
                  dur="1.2s"
                  begin={`${i * 0.3}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="cy"
                  values={`${cy + 26};${cy + 22};${cy + 26}`}
                  dur="1.2s"
                  begin={`${i * 0.3}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ))}
          </>
        )}

        {/* error sparks */}
        {petState === "error" && (
          <>
            <text x={cx - 20} y={cy - 30} fontSize="16" opacity="0.8">
              💥
              <animate
                attributeName="opacity"
                values="0.8;0.2;0.8"
                dur="0.5s"
                repeatCount="indefinite"
              />
            </text>
          </>
        )}

        <defs>
          <filter id="bodyShadow" x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.15" />
          </filter>
        </defs>
      </svg>
  );
}

function PetContextMenu({
  petSize,
  onClose,
}: {
  petSize: number;
  onClose: () => void;
}) {
  const { setSettingsOpen, setChatOpen } = useAppStore();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const items = [
    {
      label: "💬 打开聊天",
      action: () => {
        setChatOpen(true);
        onClose();
      },
    },
    {
      label: "⚙️ 设置",
      action: () => {
        setSettingsOpen(true);
        onClose();
      },
    },
    { divider: true as const },
    {
      label: "🚪 退出",
      action: () => {
        quitApp().catch(console.error);
      },
      danger: true,
    },
  ];

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.9, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 4 }}
      transition={{ duration: 0.12 }}
      className="absolute z-[999] min-w-[140px] py-1 bg-white/95 backdrop-blur-md rounded-lg shadow-lg border border-gray-200/80"
      style={{ left: petSize + 4, bottom: 8 }}
    >
      {items.map((item, i) =>
        "divider" in item ? (
          <div key={i} className="my-1 border-t border-gray-100" />
        ) : (
          <button
            key={i}
            onClick={item.action}
            className={`w-full text-left px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
              "danger" in item && item.danger
                ? "text-red-500 hover:bg-red-50"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {item.label}
          </button>
        )
      )}
    </motion.div>
  );
}

export function Pet({ size = 120 }: { size?: number }) {
  const { petState, setChatOpen, chatOpen, config, contextMenuOpen, setContextMenuOpen } =
    useAppStore();
  const controls = useAnimationControls();

  const customPath = useMemo(
    () => appearancePath(config?.pet?.appearance, petState),
    [config?.pet?.appearance, petState]
  );
  const imageSrc = useMemo(() => {
    if (customPath) return convertFileSrc(customPath);
    return BUILTIN_IMAGES[petState];
  }, [customPath, petState]);

  useEffect(() => {
    if (petState === "happy") {
      controls.start({
        y: [0, -12, 0],
        transition: { duration: 0.5, repeat: 2, ease: "easeInOut" },
      });
    } else if (petState === "error") {
      controls.start({
        x: [0, -4, 4, -4, 4, 0],
        transition: { duration: 0.4 },
      });
    }
  }, [petState, controls]);

  const handleDoubleClick = useCallback(() => {
    setChatOpen(!chatOpen);
  }, [setChatOpen, chatOpen]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      getCurrentWindow().startDragging().catch(console.error);
    },
    []
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenuOpen(true);
    },
    [setContextMenuOpen]
  );

  const handleCloseMenu = useCallback(() => {
    setContextMenuOpen(false);
  }, [setContextMenuOpen]);

  const s = size;

  return (
    <>
      <motion.div
        className="cursor-grab active:cursor-grabbing absolute bottom-0 left-0 z-50"
        animate={controls}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{ width: s, height: s }}
      >
        <img
          src={imageSrc}
          alt=""
          width={s}
          height={s}
          draggable={false}
          className="select-none block max-w-none pointer-events-none"
          style={{ objectFit: "contain" }}
        />
      </motion.div>
      <AnimatePresence>
        {contextMenuOpen && (
          <PetContextMenu petSize={s} onClose={handleCloseMenu} />
        )}
      </AnimatePresence>
    </>
  );
}
