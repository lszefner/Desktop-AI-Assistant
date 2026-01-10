import React, { useState, useEffect } from "react";

interface ThinkingBarProps {
  status?: string;
  thoughts?: string[];
  isActive?: boolean;
}

export function ThinkingBar({
  status,
  thoughts = [],
  isActive = true,
}: ThinkingBarProps) {
  const [dots, setDots] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!isActive) return;

    const startTime = Date.now();
    const interval = setInterval(() => {
      setDots((d) => (d + 1) % 4);
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 400);

    return () => clearInterval(interval);
  }, [isActive]);

  const displayStatus = status?.includes("Thinking")
    ? `Thinking${".".repeat(dots)}`
    : status;

  // Current action is the last thought or status
  const currentAction =
    thoughts.length > 0 ? thoughts[thoughts.length - 1] : displayStatus;
  const previousThoughts = thoughts.slice(0, -1);
  const hasMore =
    previousThoughts.length > 0 || (displayStatus && thoughts.length > 0);

  if (!currentAction && !displayStatus) return null;

  return (
    <div
      className="
        flex flex-col gap-1
        px-3 py-2
        bg-black/40
        rounded-lg
      "
    >
      {/* Main bar - current action */}
      <div className="flex items-center gap-2">
        {isActive && (
          <div className="flex gap-0.5">
            <div
              className="w-1 h-1 rounded-full bg-white/30 animate-pulse"
              style={{ animationDelay: "0ms" }}
            />
            <div
              className="w-1 h-1 rounded-full bg-white/30 animate-pulse"
              style={{ animationDelay: "150ms" }}
            />
            <div
              className="w-1 h-1 rounded-full bg-white/30 animate-pulse"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        )}
        <span className="text-[12px] text-white/40 font-mono flex-1">
          {currentAction || displayStatus}
        </span>
        {isActive && elapsed > 0 && (
          <span className="text-[10px] text-white/20 font-mono">
            {elapsed}s
          </span>
        )}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-white/25 hover:text-white/40 font-mono transition-colors"
          >
            {expanded
              ? "hide"
              : `+${
                  previousThoughts.length +
                  (displayStatus && thoughts.length > 0 ? 1 : 0)
                }`}
          </button>
        )}
      </div>

      {/* Expanded thoughts */}
      {expanded && hasMore && (
        <div className="flex flex-col gap-0.5 pt-1 border-t border-white/5">
          {displayStatus && thoughts.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-white/15 text-[10px]">›</span>
              <span className="text-[11px] text-white/30 font-mono">
                {displayStatus}
              </span>
            </div>
          )}
          {previousThoughts.map((thought, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-white/15 text-[10px]">›</span>
              <span className="text-[11px] text-white/30 font-mono">
                {thought}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
