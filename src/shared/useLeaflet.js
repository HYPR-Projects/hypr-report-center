import { useState, useEffect } from "react";

export const useleaflet = () => {
  const [lib, setLib] = useState(null);
  useEffect(()=>{
    if (window.L) { setLib(window.L); return; }
    // CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(link);
    // Leaflet JS
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => {
      // Leaflet Heat plugin
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js";
      s2.onload = () => setLib(window.L);
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  },[]);
  return lib;
};
