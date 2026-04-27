import { C } from "../shared/theme";

const Spinner = ({ size=24, color=C.blue }) => (
  <div style={{width:size,height:size,border:`2px solid ${color}30`,borderTop:`2px solid ${color}`,borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block"}}/>
);

export default Spinner;
