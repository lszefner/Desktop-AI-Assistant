import React from "react";

interface PanelProps {
  children: React.ReactNode;
  compact?: boolean;
}

export function Panel({ children, compact = false }: PanelProps) {
  return (
    <div
      className={`w-full h-full flex justify-center ${compact ? "p-1" : "p-2"}`}
      style={{ opacity: 1 }}
    >
      <div
        className="w-[560px] backdrop-blur-2xl rounded-2xl"
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          opacity: 1,
        }}
      >
        <div
          className={`flex flex-col ${compact ? "p-2 gap-2" : "p-3.5 gap-3"}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
