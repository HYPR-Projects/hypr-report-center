import { useState } from "react";
import { C, CL } from "../shared/theme";

const CampaignCard = ({ c, onOpenReport, onLoom, onSurvey, onLogo, onCopyLink, onOwner, copied, isDark, teamMap }) => {
  const [expanded, setExpanded] = useState(false);
  const bg    = isDark ? C.dark2 : CL.bg2;
  const bg3   = isDark ? C.dark3 : CL.bg3;
  const border= isDark ? C.dark3 : CL.border;
  const text  = isDark ? C.white : CL.text;
  const muted = isDark ? C.muted : CL.muted;

  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 14,
        overflow: "hidden",
        transition: "box-shadow 0.2s, transform 0.15s, border-color 0.2s",
        cursor: "default",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = isDark
          ? "0 8px 28px rgba(0,0,0,0.45)"
          : "0 8px 28px rgba(51,151,185,0.15)";
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.borderColor = C.blue;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = "none";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.borderColor = border;
      }}
    >
      {/* Main row */}
      <div style={{
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}>
        {/* Info */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: text }}>{c.client_name}</div>
          <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{c.campaign_name}</div>
          {c.start_date && (
            <div style={{ fontSize: 11, color: muted, marginTop: 3, opacity: 0.7 }}>
              {c.start_date} → {c.end_date || "—"}
            </div>
          )}
          {/* Owners — só admin recebe esses campos do backend */}
          {(c.cp_email || c.cs_email) && (
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              {c.cp_email && (
                <span title={`CP — ${c.cp_email}`} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: isDark ? "rgba(195,225,196,0.08)" : "rgba(46,204,113,0.10)",
                  border: `1px solid ${isDark ? "rgba(195,225,196,0.20)" : "rgba(46,204,113,0.30)"}`,
                  borderRadius: 5, padding: "2px 7px",
                  fontSize: 10, fontWeight: 600,
                  color: isDark ? "#b9d4ba" : "#1f7a44",
                  letterSpacing: 0.3,
                }}>
                  <span style={{ opacity: 0.7, fontSize: 9 }}>CP</span>
                  {(teamMap?.[c.cp_email] || c.cp_email.split("@")[0]).split(" ")[0]}
                </span>
              )}
              {c.cs_email && (
                <span title={`CS — ${c.cs_email}`} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: `${C.blue}14`,
                  border: `1px solid ${C.blue}30`,
                  borderRadius: 5, padding: "2px 7px",
                  fontSize: 10, fontWeight: 600,
                  color: C.blue,
                  letterSpacing: 0.3,
                }}>
                  <span style={{ opacity: 0.7, fontSize: 9 }}>CS</span>
                  {(teamMap?.[c.cs_email] || c.cs_email.split("@")[0]).split(" ")[0]}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Metric badges — display_pacing, video_pacing, display_ctr, video_vtr */}
        {(c.display_pacing != null || c.video_pacing != null || c.display_ctr != null || c.video_vtr != null) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {c.display_pacing != null && (
              <div title="Pacing Display" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${
                  c.display_pacing >= 90 && c.display_pacing <= 110 ? "#3397B930" :
                  c.display_pacing < 70 ? "#e5534b30" : "#f0a52930"
                }`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>DSP PAC</span>
                <span style={{ fontSize: 12, fontWeight: 700, color:
                  c.display_pacing >= 90 && c.display_pacing <= 110 ? C.blue :
                  c.display_pacing < 70 ? "#e5534b" : "#f0a529"
                }}>{c.display_pacing.toFixed(0)}%</span>
              </div>
            )}
            {c.video_pacing != null && (
              <div title="Pacing Video" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${
                  c.video_pacing >= 90 && c.video_pacing <= 110 ? "#3397B930" :
                  c.video_pacing < 70 ? "#e5534b30" : "#f0a52930"
                }`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>VID PAC</span>
                <span style={{ fontSize: 12, fontWeight: 700, color:
                  c.video_pacing >= 90 && c.video_pacing <= 110 ? C.blue :
                  c.video_pacing < 70 ? "#e5534b" : "#f0a529"
                }}>{c.video_pacing.toFixed(0)}%</span>
              </div>
            )}
            {c.display_ctr != null && (
              <div title="CTR Display" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${muted}25`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>CTR</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: text }}>{c.display_ctr.toFixed(2)}%</span>
              </div>
            )}
            {c.video_vtr != null && (
              <div title="VTR (View-Through Rate)" style={{
                background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${muted}25`,
                borderRadius: 6, padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
              }}>
                <span style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>VTR</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: text }}>{c.video_vtr.toFixed(2)}%</span>
              </div>
            )}
          </div>
        )}

        {/* Token badge */}
        <div style={{
          background: `${C.blue}18`,
          border: `1px solid ${C.blue}35`,
          borderRadius: 7,
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 700,
          color: C.blue,
          letterSpacing: 1,
          fontFamily: "monospace",
        }}>{c.short_token}</div>

        {/* Ver Report */}
        <button
          onClick={() => onOpenReport(c.short_token)}
          style={{
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: "8px 18px",
            borderRadius: 9,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.3,
            transition: "background 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = C.blueDark}
          onMouseLeave={e => e.currentTarget.style.background = C.blue}
        >Ver Report</button>

        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(v => !v)}
          title="Mais ações"
          style={{
            background: expanded ? `${C.blue}18` : bg3,
            border: `1px solid ${expanded ? C.blue + "40" : border}`,
            color: expanded ? C.blue : muted,
            width: 34,
            height: 34,
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.2s",
            flexShrink: 0,
          }}
        >
          <span style={{ display: "inline-block", transition: "transform 0.2s", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
        </button>
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${border}`,
          padding: "12px 18px",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          background: bg3,
        }}>
          {[
            { label: "🎥 Loom",       onClick: () => onLoom(c.short_token) },
            { label: "📋 Survey",     onClick: () => onSurvey(c.short_token) },
            { label: "🖼️ Logo",       onClick: () => onLogo(c.short_token) },
            { label: "👤 Owner",      onClick: () => onOwner(c) },
            {
              label: copied === c.short_token ? "✓ Copiado!" : "🔗 Link Cliente",
              onClick: () => onCopyLink(c.short_token),
              highlight: copied === c.short_token,
            },
          ].map(btn => (
            <button
              key={btn.label}
              onClick={btn.onClick}
              style={{
                background: btn.highlight ? `${C.accent}22` : (isDark ? C.dark2 : CL.bg2),
                color: btn.highlight ? "#b8960a" : muted,
                border: `1px solid ${btn.highlight ? C.accent + "60" : border}`,
                padding: "7px 14px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { if (!btn.highlight) { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.blue; } }}
              onMouseLeave={e => { if (!btn.highlight) { e.currentTarget.style.borderColor = border; e.currentTarget.style.color = muted; } }}
            >{btn.label}</button>
          ))}
        </div>
      )}
    </div>
  );
};

// Month group with collapsible

export default CampaignCard;
