const HyprLogo = ({ height=32, center=false, isDark=true }) => (
  <img src="/logo.png" alt="HYPR" style={{height, width:"auto", display:"block", margin:center?"0 auto":"0", filter: isDark ? "none" : "invert(1)"}} />
);

export default HyprLogo;
