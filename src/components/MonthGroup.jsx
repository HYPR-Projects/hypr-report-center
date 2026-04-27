import { useState } from "react";
import { C, CL } from "../shared/theme";
import CampaignCard from "./CampaignCard";

const MonthGroup = ({ label, items, defaultOpen, isDark, ...cardProps }) => {
  const [open, setOpen] = useState(defaultOpen);
  const border = isDark ? C.dark3 : CL.border;
  const muted  = isDark ? C.muted : CL.muted;
  const bg2    = isDark ? C.dark2 : CL.bg2;

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 4px",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: muted,
          textTransform: "uppercase",
          letterSpacing: 2,
          flex: 1,
        }}>{label}</span>
        <span style={{
          background: isDark ? C.dark3 : CL.bg3,
          color: muted,
          fontSize: 11,
          fontWeight: 600,
          borderRadius: 20,
          padding: "2px 9px",
          border: `1px solid ${border}`,
        }}>{items.length}</span>
        <span style={{
          color: C.blue,
          fontSize: 14,
          display: "inline-block",
          transition: "transform 0.2s",
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
        }}>▾</span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 8 }}>
          {items.map((c, i) => (
            <div key={c.short_token} className="fade-in" style={{ animationDelay: `${i * 18}ms` }}>
              <CampaignCard c={c} isDark={isDark} {...cardProps} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MonthGroup;
