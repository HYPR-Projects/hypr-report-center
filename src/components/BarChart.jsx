import { BarChart as RechartBar, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { C } from "../shared/theme";

const BarChart = ({ data, xKey, yKey, color = C.blue, height = 160, formatter, rotateX = false, theme }) => {
  if (!data?.length) return null;
  const grid    = theme?.bdr  || C.dark3;
  const tickClr = theme?.muted|| C.muted;
  const tipBg   = theme?.bg2  || C.dark2;
  const tipBdr  = theme?.bdr  || C.dark3;
  const tipTxt  = theme?.text;
  const fmtVal = (v) => {
    if (v >= 1000000) return `${(v/1000000).toFixed(1)}M`;
    if (v >= 1000)    return `${(v/1000).toFixed(0)}K`;
    return String(v);
  };
  return (
    <ResponsiveContainer width="98%" height={height} style={{overflow:"hidden"}}>
      <RechartBar data={data} margin={{ top: 4, right: 8, left: 0, bottom: rotateX ? 60 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: tickClr, fontSize: 10, angle: rotateX ? -35 : 0, textAnchor: rotateX ? "end" : "middle", dy: rotateX ? 8 : 0 }} tickLine={false} tickFormatter={v => rotateX ? String(v) : String(v).slice(5)} interval="preserveStartEnd" />
        <YAxis tick={{ fill: tickClr, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={fmtVal} width={44} />
        <RTooltip contentStyle={{ background: tipBg, border: `1px solid ${tipBdr}`, borderRadius: 8, fontSize: 12, color: tipTxt }} formatter={formatter || ((v) => [fmtVal(v)])} labelFormatter={l => `Data: ${l}`} />
        <Bar dataKey={yKey} fill={color} radius={[3, 3, 0, 0]} opacity={0.85} />
      </RechartBar>
    </ResponsiveContainer>
  );
};

export default BarChart;
