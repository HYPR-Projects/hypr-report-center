import { LineChart, Line, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { C } from "../shared/theme";

const DualChart = ({ data, xKey, y1Key, y2Key, label1, label2, color1=C.blue, color2=C.blueLight, height=180 }) => {
  if (!data?.length) return null;
  const isDate = data.length > 0 && /^\d{4}-\d{2}/.test(String(data[0][xKey]));
  const fmtBig = (v) => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : String(v);
  const fmtPct = (v) => `${Number(v).toFixed(2)}%`;
  return (
    <div>
      <div style={{display:"flex",gap:16,marginBottom:8}}>
        <span style={{fontSize:11,color:color1,fontWeight:600}}>● {label1}</span>
        <span style={{fontSize:11,color:color2,fontWeight:600}}>● {label2}</span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{top:4,right:64,left:8,bottom:4}}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.dark3} vertical={false}/>
          <XAxis dataKey={xKey} tick={{fill:C.muted,fontSize:10}} tickLine={false} tickFormatter={v=> isDate ? String(v).slice(5) : String(v)} interval="preserveStartEnd"/>
          <YAxis yAxisId="left" tick={{fill:C.muted,fontSize:10}} tickLine={false} axisLine={false} tickFormatter={fmtBig} width={52}/>
          <YAxis yAxisId="right" orientation="right" tick={{fill:C.muted,fontSize:10}} tickLine={false} axisLine={false} tickFormatter={fmtPct} width={56}/>
          <RTooltip
            contentStyle={{background:C.dark2,border:`1px solid ${C.dark3}`,borderRadius:8,fontSize:12}}
            formatter={(v,name) => name===label2 ? [fmtPct(v),name] : [fmtBig(v),name]}
            labelFormatter={l=>`Data: ${l}`}
          />
      <Bar yAxisId="left" dataKey={y1Key} name={label1} fill={color1} radius={[3,3,0,0]} opacity={0.75} isAnimationActive={false} barSize={Math.min(32, Math.max(8, Math.floor(600/data.length)))}/>          <Line yAxisId="right" dataKey={y2Key} name={label2} type="monotone" stroke={color2} strokeWidth={2} dot={{r:3,fill:color2}} activeDot={{r:5}}/>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── Detail Table with CSV download ───────────────────────────────────────────

export default DualChart;
